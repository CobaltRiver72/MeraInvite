// POST /api/checkout  { designId, provider, email?, turnstileToken, attemptKey }
// Idempotent: a retry / double-click / reload with the same attemptKey reuses the
// SAME order + payment object (no double-charge). Price is read from the DB.
// Stripe uses hosted Checkout Sessions (Stripe hosts the payment page); Razorpay
// keeps its order-based flow.
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

// Base site URL for Checkout redirects (strip any trailing slash so we don't
// build `//success`).
function siteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL!.replace(/\/$/, "");
}

// Build a hosted Checkout Session for one order. Price + display name come from
// the DB row (never the client). `idempotencyKey` makes a retried create return
// the SAME session instead of a duplicate. Used for both the first attempt and
// the recreate-after-expiry path, so the two stay priced identically.
function createStripeCheckoutSession(
  stripe: Stripe,
  args: {
    design: { id: string; slug: string; name: string };
    orderToken: string;
    amount: number;
    currency: string;
    email?: string;
    attemptKey: string;
    idempotencyKey: string;
  }
) {
  const site = siteUrl();
  return stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: args.currency,
            product_data: { name: args.design.name },
            unit_amount: args.amount, // SERVER-AUTHORITATIVE (DB), never client
          },
          quantity: 1,
        },
      ],
      client_reference_id: args.orderToken,
      metadata: { order_token: args.orderToken, design_id: args.design.id, attempt_key: args.attemptKey },
      customer_email: args.email ?? undefined,
      success_url: `${site}/success`,
      cancel_url: `${site}/editor/${args.design.slug}`,
    },
    { idempotencyKey: args.idempotencyKey }
  );
}

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
    .select("id, order_token, design_id, provider, provider_ref, status")
    .eq("attempt_key", body.attemptKey)
    .maybeSingle();
  if (existing) {
    if (existing.status === "paid") {
      return NextResponse.json({ orderToken: existing.order_token, alreadyPaid: true });
    }
    if (existing.status === "pending" && existing.provider_ref) {
      if (existing.provider === "razorpay") {
        return NextResponse.json({ orderToken: existing.order_token, razorpayOrderId: existing.provider_ref });
      }
      // Stripe: reuse the still-open Checkout Session; recreate only if expired.
      const session = await stripe.checkout.sessions.retrieve(existing.provider_ref);
      if (session.status === "open" && session.url) {
        return NextResponse.json({ orderToken: existing.order_token, url: session.url });
      }
      if (session.status === "complete") {
        // Paid (webhook may still be in flight) — route to download, don't recharge.
        return NextResponse.json({ orderToken: existing.order_token, alreadyPaid: true });
      }
      // Expired: mint a replacement session for the SAME order. A fresh
      // idempotency key is required — reusing attemptKey would just replay the
      // expired session.
      const { data: design } = await db
        .from("designs")
        .select("id, slug, name, price_usd, active")
        .eq("id", existing.design_id)
        .single();
      if (!design || !design.active) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      try {
        const fresh = await createStripeCheckoutSession(stripe, {
          design,
          orderToken: existing.order_token,
          amount: design.price_usd, // stripe = USD
          currency: "usd",
          email: body.email,
          attemptKey: body.attemptKey,
          idempotencyKey: `${body.attemptKey}:${existing.provider_ref}`,
        });
        await db.from("orders").update({ provider_ref: fresh.id }).eq("id", existing.id);
        return NextResponse.json({ orderToken: existing.order_token, url: fresh.url });
      } catch {
        return NextResponse.json({ error: "payment_init_failed" }, { status: 502 });
      }
    }
  }

  // Look up the design (server-authoritative price).
  const { data: design, error } = await db
    .from("designs")
    .select("id, slug, name, is_premium, price_usd, price_inr, active")
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
        const session = await stripe.checkout.sessions.retrieve(raced.provider_ref);
        return NextResponse.json({ orderToken: raced.order_token, url: session.url });
      }
      return NextResponse.json({ orderToken: raced.order_token, razorpayOrderId: raced.provider_ref });
    }
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  try {
    if (body.provider === "stripe") {
      // Gateway-side idempotency: same key never creates a second session.
      const session = await createStripeCheckoutSession(stripe, {
        design,
        orderToken,
        amount,
        currency,
        email: body.email,
        attemptKey: body.attemptKey,
        idempotencyKey: body.attemptKey,
      });
      await db.from("orders").update({ provider_ref: session.id }).eq("id", order.id);
      return NextResponse.json({ orderToken, url: session.url });
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
