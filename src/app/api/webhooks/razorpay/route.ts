// POST /api/webhooks/razorpay — verifies HMAC-SHA256 over the RAW body,
// then grants atomically via the process_payment RPC.
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { deletePrivatePrefix } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function valid(raw: string, sig: string | null) {
  if (!sig) return false;
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET!)
    .update(raw)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("x-razorpay-signature");
  if (!valid(raw, sig)) return NextResponse.json({ error: "bad_signature" }, { status: 400 });

  const event = JSON.parse(raw);
  const eventId =
    req.headers.get("x-razorpay-event-id") ||
    crypto.createHash("sha256").update(raw).digest("hex");
  const db = supabaseAdmin();

  if (event.event === "payment.captured") {
    const p = event.payload?.payment?.entity;
    // Grant + enqueue the download email atomically (email handled by outbox RPC).
    await db.rpc("process_payment", {
      p_provider: "razorpay",
      p_event_id: eventId,
      p_provider_ref: p?.order_id,
      p_amount: p?.amount,
      p_currency: (p?.currency || "").toLowerCase(),
    });
  } else if (event.event === "refund.processed") {
    const ref = event.payload?.payment?.entity?.order_id;
    const { data: result } = await db.rpc("revoke_payment", {
      p_provider: "razorpay",
      p_event_id: eventId,
      p_provider_ref: ref,
    });
    if (result === "ok") {
      const { data: o } = await db.from("orders").select("id").eq("provider_ref", ref).maybeSingle();
      if (o) await deletePrivatePrefix(`rendered/${o.id}/`);
    }
  }

  return NextResponse.json({ received: true });
}
