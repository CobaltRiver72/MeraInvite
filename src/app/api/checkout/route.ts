// POST /api/checkout  { designId, provider, email?, turnstileToken, attemptKey }
// Idempotent: a retry / double-click / reload with the same attemptKey reuses the
// SAME order + payment object (no double-charge). Price is read from the DB.
import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "node:crypto";
import Stripe from "stripe";
import Razorpay from "razorpay";
import { supabaseAdmin } from "@/lib/supabase";
import { limit, clientIp } from "@/lib/ratelimit";
import { verifyTurnstile } from "@/lib/turnstile";

export const runtime = "nodejs";

const Body = z.object({
  designId: z.string().uuid(),
  provider: z.enum(["stripe", "razorpay"]),
  email: z.string().email().optional(),
  turnstileToken: z.string().min(1), // Cloudflare Turnstile (anti-bot / card-testing)
  attemptKey: z.string().uuid(),     // one per checkout attempt — primary idempotency
});

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!(await limit("checkout", ip))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Bot / card-testing gate.
  if (!(await verifyTurnstile(body.turnstileToken, ip))) {
    return NextResponse.json({ error: "challenge_failed" }, { status: 403 });
  }
  if (body.email && !(await limit("checkoutEmail", body.email.toLowerCase()))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const db = supabaseAdmin();
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

  // (1) IDEMPOTENCY: reuse an existing order for this attemptKey (<24h).
  const { data: existing } = await db
    .from("orders")
    .select("id, order_token, provider, provider_ref, status")
    .eq("attempt_key", body.attemptKey)
    .maybeSingle();
  if (existing) {
    if (existing.status === "paid") {
      return NextResponse.json({ orderToken: existing.order_token, alreadyPaid: true });
    }
    if (existing.status === "pending" && existing.provider_ref) {
      if (existing.provider === "stripe") {
        const pi = await stripe.paymentIntents.retrieve(existing.provider_ref);
        return NextResponse.json({ orderToken: existing.order_token, clientSecret: pi.client_secret });
      }
      return NextResponse.json({ orderToken: existing.order_token, razorpayOrderId: existing.provider_ref });
    }
  }

  // Look up the design (server-authoritative price).
  const { data: design, error } = await db
    .from("designs")
    .select("id, is_premium, price_usd, price_inr, active")
    .eq("id", body.designId)
    .single();
  if (error || !design || !design.active) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!design.is_premium) {
    return NextResponse.json({ error: "design_is_free" }, { status: 400 });
  }

  // (2) ALREADY-PAID SHORT-CIRCUIT: this email already owns this design -> no new charge.
  if (body.email) {
    const { data: paid } = await db
      .from("orders")
      .select("id, order_token")
      .eq("design_id", design.id)
      .eq("email", body.email)
      .eq("status", "paid")
      .order("paid_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (paid) {
      const { data: ent } = await db
        .from("entitlements").select("revoked").eq("order_id", paid.id).maybeSingle();
      if (ent && !ent.revoked) {
        return NextResponse.json({ orderToken: paid.order_token, alreadyPaid: true });
      }
    }
  }

  const isInr = body.provider === "razorpay";
  const amount = isInr ? design.price_inr : design.price_usd; // SERVER-AUTHORITATIVE
  const currency = isInr ? "inr" : "usd";
  const orderToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Create the pending order. Unique attempt_key guards against a concurrent dup.
  const { data: order, error: oErr } = await db
    .from("orders")
    .insert({
      order_token: orderToken, design_id: design.id, email: body.email ?? null,
      amount, currency, provider: body.provider, status: "pending",
      attempt_key: body.attemptKey, expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (oErr || !order) {
    // Lost a race on attempt_key — reuse the order the other request created.
    const { data: raced } = await db
      .from("orders").select("order_token, provider, provider_ref").eq("attempt_key", body.attemptKey).maybeSingle();
    if (raced?.provider_ref) {
      if (raced.provider === "stripe") {
        const pi = await stripe.paymentIntents.retrieve(raced.provider_ref);
        return NextResponse.json({ orderToken: raced.order_token, clientSecret: pi.client_secret });
      }
      return NextResponse.json({ orderToken: raced.order_token, razorpayOrderId: raced.provider_ref });
    }
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  try {
    if (body.provider === "stripe") {
      // Gateway-side idempotency: same key never creates a second intent.
      const pi = await stripe.paymentIntents.create(
        { amount, currency, metadata: { order_token: orderToken, design_id: design.id }, automatic_payment_methods: { enabled: true } },
        { idempotencyKey: body.attemptKey }
      );
      await db.from("orders").update({ provider_ref: pi.id }).eq("id", order.id);
      return NextResponse.json({ orderToken, clientSecret: pi.client_secret });
    } else {
      const rzp = new Razorpay({
        key_id: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID!,
        key_secret: process.env.RAZORPAY_KEY_SECRET!,
      });
      // receipt = attemptKey acts as a secondary idempotency handle (≤40 chars).
      // `any`: the razorpay SDK's callback overloads mistype the awaited result.
      const ro: any = await rzp.orders.create({
        amount, currency: "INR",
        receipt: body.attemptKey.slice(0, 40),
        notes: { order_token: orderToken, design_id: design.id },
      });
      await db.from("orders").update({ provider_ref: ro.id }).eq("id", order.id);
      return NextResponse.json({ orderToken, razorpayOrderId: ro.id });
    }
  } catch {
    return NextResponse.json({ error: "payment_init_failed" }, { status: 502 });
  }
}
