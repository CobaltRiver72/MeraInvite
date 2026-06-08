// POST /api/webhooks/stripe — the ONLY place an order becomes "paid".
// Verifies signature on the RAW body; grants atomically via process_payment RPC
// (idempotency + mark-paid + entitlement in one Postgres transaction).
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase";
import { deletePrivatePrefix } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  const raw = await req.text(); // RAW body required for signature verification
  if (!sig) return NextResponse.json({ error: "no_sig" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return NextResponse.json({ error: "bad_signature" }, { status: 400 });
  }

  const db = supabaseAdmin();

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object as Stripe.PaymentIntent;
    // Grant + enqueue the download email atomically (email handled by outbox RPC).
    await db.rpc("process_payment", {
      p_provider: "stripe",
      p_event_id: event.id,
      p_provider_ref: pi.id,
      p_amount: pi.amount,
      p_currency: pi.currency,
    });
  } else if (event.type === "charge.refunded") {
    const ch = event.data.object as Stripe.Charge;
    const ref = ch.payment_intent as string;
    const { data: result } = await db.rpc("revoke_payment", {
      p_provider: "stripe",
      p_event_id: event.id,
      p_provider_ref: ref,
    });
    if (result === "ok") {
      const { data: o } = await db.from("orders").select("id").eq("provider_ref", ref).maybeSingle();
      if (o) await deletePrivatePrefix(`rendered/${o.id}/`); // kill cached renders
    }
  }

  return NextResponse.json({ received: true });
}
