// GET /api/cron/reconcile — the backstop. Run ~every 5 min (Vercel Cron / external).
// (1) Catch payments whose webhook was missed, (2) expire stale pendings + cancel
// the intent, (3) auto-refund genuine duplicate charges. Bulk-lists to avoid 429s.
import { NextResponse } from "next/server";
import Stripe from "stripe";
import Razorpay from "razorpay";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";

export const runtime = "nodejs";
export const maxDuration = 60;

const MIN_AGE_MS = 3 * 60 * 1000;   // ignore very fresh orders (webhook may still arrive)
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // ignore ancient ones
const MAX_ATTEMPTS = 3;

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const rzp = new Razorpay({
    key_id: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID!,
    key_secret: process.env.RAZORPAY_KEY_SECRET!,
  });
  const now = Date.now();

  // ---- pending orders in the reconciliation window ----
  const { data: pend } = await db
    .from("orders")
    .select("id, provider, provider_ref, amount, currency, reconciliation_attempts")
    .eq("status", "pending")
    .lt("created_at", new Date(now - MIN_AGE_MS).toISOString())
    .gt("created_at", new Date(now - MAX_AGE_MS).toISOString());

  // Bulk-list Stripe intents once (avoids per-order retrieve / 429s).
  const stripeOk = new Map<string, Stripe.PaymentIntent>();
  try {
    const list = await stripe.paymentIntents.list({
      created: { gte: Math.floor((now - MAX_AGE_MS) / 1000) },
      limit: 100,
    });
    for (const pi of list.data) if (pi.status === "succeeded") stripeOk.set(pi.id, pi);
  } catch { /* ignore — try again next run */ }

  let fulfilled = 0, expired = 0;
  for (const o of pend ?? []) {
    let paid = false;
    if (o.provider === "stripe" && o.provider_ref && stripeOk.has(o.provider_ref)) {
      const pi = stripeOk.get(o.provider_ref)!;
      await db.rpc("process_payment", {
        p_provider: "stripe", p_event_id: "reconcile_" + pi.id,
        p_provider_ref: pi.id, p_amount: pi.amount, p_currency: pi.currency,
      });
      paid = true;
    } else if (o.provider === "razorpay" && o.provider_ref) {
      try {
        const pays: any = await rzp.orders.fetchPayments(o.provider_ref);
        const cap = (pays.items || []).find((x: any) => x.status === "captured");
        if (cap) {
          await db.rpc("process_payment", {
            p_provider: "razorpay", p_event_id: "reconcile_" + cap.id,
            p_provider_ref: o.provider_ref, p_amount: cap.amount,
            p_currency: String(cap.currency || "").toLowerCase(),
          });
          paid = true;
        }
      } catch { /* skip */ }
    }

    if (paid) { fulfilled++; continue; }

    // Not paid yet — bump attempts; expire + cancel after the cap.
    const att = (o.reconciliation_attempts ?? 0) + 1;
    if (att >= MAX_ATTEMPTS) {
      await db.from("orders").update({ status: "expired", reconciliation_attempts: att }).eq("id", o.id);
      if (o.provider === "stripe" && o.provider_ref) {
        try { await stripe.paymentIntents.cancel(o.provider_ref); } catch { /* may be uncancelable */ }
      }
      expired++;
    } else {
      await db.from("orders").update({ reconciliation_attempts: att }).eq("id", o.id);
    }
  }

  // ---- duplicate-charge remediation: same email+design paid >1 in last 15 min ----
  let refunded = 0;
  const { data: recent } = await db
    .from("orders")
    .select("id, email, design_id, provider, provider_ref, paid_at")
    .eq("status", "paid")
    .gt("paid_at", new Date(now - 15 * 60 * 1000).toISOString());
  const groups: Record<string, any[]> = {};
  for (const o of recent ?? []) {
    if (!o.email) continue;
    (groups[`${o.email}::${o.design_id}`] ??= []).push(o);
  }
  for (const key in groups) {
    const g = groups[key].sort((a, b) => +new Date(a.paid_at) - +new Date(b.paid_at));
    for (const dup of g.slice(1)) { // keep earliest, refund the rest
      try {
        if (dup.provider === "stripe" && dup.provider_ref) {
          await stripe.refunds.create({ payment_intent: dup.provider_ref });
        } else if (dup.provider === "razorpay" && dup.provider_ref) {
          const pays: any = await rzp.orders.fetchPayments(dup.provider_ref);
          const cap = (pays.items || []).find((x: any) => x.status === "captured");
          if (cap) await rzp.payments.refund(cap.id, {});
        }
        await db.from("orders").update({ status: "refunded" }).eq("id", dup.id);
        await db.from("entitlements").update({ revoked: true }).eq("order_id", dup.id);
        refunded++;
        // NOTE: provider will also fire a refund webhook -> R2 renders cleaned up there.
      } catch { /* alert + manual handling */ }
    }
  }

  return NextResponse.json({ fulfilled, expired, refunded });
}
