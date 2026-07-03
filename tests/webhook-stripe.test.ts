// POST /api/webhooks/stripe — the only place an order becomes "paid".
// Signature verification is REAL (Stripe's own constructEvent over the raw body,
// signed here with generateTestHeaderString). Only network-touching calls
// (checkout.sessions.list) and the DB/R2 are stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const WEBHOOK_SECRET = "whsec_test_dummy_secret"; // matches vitest.config.ts env

const { rpc, deletePrivatePrefix, sessionsList, orderRow } = vi.hoisted(() => ({
  rpc: vi.fn(),
  deletePrivatePrefix: vi.fn(),
  sessionsList: vi.fn(),
  orderRow: { current: { id: "order-1" } as { id: string } | null },
}));

// Keep Stripe's REAL webhook verification; stub only the network resource used
// by the refund path (checkout.sessions.list).
vi.mock("stripe", async (importActual) => {
  const actual = await importActual<typeof import("stripe")>();
  const RealStripe = actual.default;
  return {
    default: class extends RealStripe {
      checkout = { sessions: { list: sessionsList, create: vi.fn(), retrieve: vi.fn() } } as any;
    },
  };
});

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    rpc,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: orderRow.current }) }) }),
    }),
  }),
}));

vi.mock("@/lib/r2", () => ({ deletePrivatePrefix }));

import Stripe from "stripe";
import { POST } from "@/app/api/webhooks/stripe/route";

// Real signer — produces a header constructEvent accepts for `payload`.
const signer = new Stripe("sk_test_dummy");

function event(id: string, type: string, object: Record<string, any>) {
  return {
    id,
    object: "event",
    type,
    data: { object },
    created: 1_700_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
  };
}

function signedRequest(evt: object, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(evt);
  const header = signer.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

const paidSession = {
  id: "cs_test_a1",
  object: "checkout.session",
  payment_status: "paid",
  amount_total: 1999,
  currency: "usd",
  payment_intent: "pi_123",
};

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: "ok" });
  orderRow.current = { id: "order-1" };
});

describe("POST /api/webhooks/stripe", () => {
  it("grants once on checkout.session.completed with payment_status paid", async () => {
    const res = await POST(signedRequest(event("evt_1", "checkout.session.completed", paidSession)));
    expect(res.status).toBe(200);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("process_payment", {
      p_provider: "stripe",
      p_event_id: "evt_1",
      p_provider_ref: "cs_test_a1", // the SESSION id, matching the order row
      p_amount: 1999,
      p_currency: "usd",
    });
  });

  it("also grants on checkout.session.async_payment_succeeded", async () => {
    const res = await POST(signedRequest(event("evt_2", "checkout.session.async_payment_succeeded", paidSession)));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("process_payment", expect.objectContaining({ p_event_id: "evt_2", p_provider_ref: "cs_test_a1" }));
  });

  it("does NOT grant when payment_status is not paid", async () => {
    const unpaid = { ...paidSession, payment_status: "unpaid" };
    const res = await POST(signedRequest(event("evt_3", "checkout.session.completed", unpaid)));
    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("is idempotent when the same event id is replayed — one grant", async () => {
    const seen = new Set<string>();
    let grants = 0;
    rpc.mockImplementation(async (fn: string, args: any) => {
      if (fn !== "process_payment") return { data: "ok" };
      if (seen.has(args.p_event_id)) return { data: "duplicate" }; // processed_events unique insert
      seen.add(args.p_event_id);
      grants++;
      return { data: "ok" };
    });

    const evt = event("evt_dup", "checkout.session.completed", paidSession);
    await POST(signedRequest(evt));
    await POST(signedRequest(evt)); // Stripe redelivery

    expect(rpc).toHaveBeenCalledTimes(2); // route calls the RPC each delivery…
    expect(grants).toBe(1); // …but only one grant lands (DB-enforced idempotency)
  });

  it("rejects a bad signature with 400 and never touches the DB", async () => {
    const evt = event("evt_bad", "checkout.session.completed", paidSession);
    const res = await POST(signedRequest(evt, "whsec_the_wrong_secret"));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a missing signature header with 400", async () => {
    const req = new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      body: JSON.stringify(event("evt_x", "checkout.session.completed", paidSession)),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("revokes and purges renders on charge.refunded, resolving the session from the payment_intent", async () => {
    sessionsList.mockResolvedValue({ data: [{ id: "cs_test_a1" }] });
    rpc.mockResolvedValue({ data: "ok" });

    const charge = { id: "ch_1", object: "charge", payment_intent: "pi_123" };
    const res = await POST(signedRequest(event("evt_refund", "charge.refunded", charge)));
    expect(res.status).toBe(200);

    // provider_ref on orders is the session id, so resolve it from the PI first.
    expect(sessionsList).toHaveBeenCalledWith({ payment_intent: "pi_123", limit: 1 });
    expect(rpc).toHaveBeenCalledWith("revoke_payment", {
      p_provider: "stripe",
      p_event_id: "evt_refund",
      p_provider_ref: "cs_test_a1",
    });
    expect(deletePrivatePrefix).toHaveBeenCalledWith("rendered/order-1/");
  });
});
