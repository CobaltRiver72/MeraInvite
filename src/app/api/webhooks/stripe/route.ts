// POST /api/webhooks/stripe — the ONLY place an order becomes "paid".
// Verifies the signature on the RAW body, then grants atomically via the
// process_payment RPC (idempotency + mark-paid + entitlement + outbox email in
// one Postgres transaction). Fulfilment is driven by hosted Checkout Sessions,
// so the grant fires on `checkout.session.completed`.
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

  // A hosted Checkout completes synchronously (`completed`) or, for async payment
  // methods, later (`async_payment_succeeded`). Both must be confirmed `paid`.
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.payment_status !== "paid") {
      return NextResponse.json({ received: true }); // e.g. still processing — no grant
    }
    // provider_ref is the SESSION id (saved at checkout), so key the grant on s.id.
    const { error } = await db.rpc("process_payment", {
      p_provider: "stripe",
      p_event_id: event.id,
      p_provider_ref: s.id,
      p_amount: s.amount_total,
      p_currency: s.currency,
    });
    if (error) {
      // Transport/DB failure — let Stripe retry; process_payment is replay-safe.
      return NextResponse.json({ error: "processing_failed" }, { status: 500 });
    }
  } else if (event.type === "charge.refunded") {
    const ch = event.data.object as Stripe.Charge;
    const paymentIntent = ch.payment_intent as string;
    // The charge only carries the PaymentIntent; our order row is keyed by the
    // Checkout Session id, so resolve the session from the PI before revoking.
    const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntent, limit: 1 });
    const sessionId = sessions.data[0]?.id;
    if (!sessionId) return NextResponse.json({ received: true });

    const { data: result } = await db.rpc("revoke_payment", {
      p_provider: "stripe",
      p_event_id: event.id,
      p_provider_ref: sessionId,
    });
    if (result === "ok") {
      const { data: o } = await db.from("orders").select("id").eq("provider_ref", sessionId).maybeSingle();
      if (o) await deletePrivatePrefix(`rendered/${o.id}/`); // kill cached renders
    }
  }

  return NextResponse.json({ received: true });
}
