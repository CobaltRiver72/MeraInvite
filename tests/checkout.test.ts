// POST /api/checkout — Stripe branch. Hosted Checkout Sessions with DB-priced
// line items, attempt_key idempotency (one order + one session per attempt),
// and server-authoritative pricing. Stripe + Supabase are mocked; no network.
import { beforeEach, describe, expect, it, vi } from "vitest";

const DESIGN_ID = "22222222-2222-4222-8222-222222222222";
const FREE_DESIGN_ID = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_KEY = "11111111-1111-4111-8111-111111111111";

// In-memory tables shared with the supabase mock (hoisted: vi.mock factories
// run when the route module is imported, before this file's body).
const db = vi.hoisted(() => ({
  designs: [] as Record<string, any>[],
  orders: [] as Record<string, any>[],
  entitlements: [] as Record<string, any>[],
  reset() {
    this.designs.length = 0;
    this.orders.length = 0;
    this.entitlements.length = 0;
  },
}));

const { sessionsCreate, sessionsRetrieve, paymentIntentsCreate } = vi.hoisted(() => ({
  sessionsCreate: vi.fn(),
  sessionsRetrieve: vi.fn(),
  paymentIntentsCreate: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class StripeMock {
    checkout = { sessions: { create: sessionsCreate, retrieve: sessionsRetrieve } };
    paymentIntents = { create: paymentIntentsCreate, retrieve: vi.fn() };
  },
}));

vi.mock("razorpay", () => ({ default: class RazorpayMock {} }));

// Minimal supabase-js query-builder over the in-memory tables. Emulates the
// unique partial index on orders.attempt_key (insert conflict → 23505).
vi.mock("@/lib/supabase", () => {
  function table(name: "designs" | "orders" | "entitlements") {
    const rows = () => db[name];
    const filters: Array<[string, any]> = [];
    let pendingInsert: Record<string, any> | null = null;
    let pendingUpdate: Record<string, any> | null = null;
    const filtered = () => filters.reduce((acc, [col, val]) => acc.filter((r) => r[col] === val), rows());

    function exec(mode: "single" | "maybeSingle" | "many") {
      if (pendingInsert) {
        if (name === "orders" && pendingInsert.attempt_key && rows().some((r) => r.attempt_key === pendingInsert!.attempt_key)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        const row = { id: `${name}-${rows().length + 1}`, ...pendingInsert };
        rows().push(row);
        return { data: mode === "many" ? [row] : row, error: null };
      }
      if (pendingUpdate) {
        const targets = filtered();
        for (const r of targets) Object.assign(r, pendingUpdate);
        return { data: targets, error: null };
      }
      const found = filtered();
      if (mode === "single") {
        return found.length === 1 ? { data: found[0], error: null } : { data: null, error: { message: "expected a single row" } };
      }
      if (mode === "maybeSingle") return { data: found[0] ?? null, error: null };
      return { data: found, error: null };
    }

    const api: any = {
      select: () => api,
      insert: (row: Record<string, any>) => ((pendingInsert = row), api),
      update: (patch: Record<string, any>) => ((pendingUpdate = patch), api),
      eq: (col: string, val: any) => (filters.push([col, val]), api),
      order: () => api,
      limit: () => api,
      single: async () => exec("single"),
      maybeSingle: async () => exec("maybeSingle"),
      then: (resolve: any, reject: any) => Promise.resolve(exec("many")).then(resolve, reject),
    };
    return api;
  }
  return { supabaseAdmin: () => ({ from: table }) };
});

vi.mock("@/lib/ratelimit", () => ({ limit: async () => true, clientIp: () => "203.0.113.7" }));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: async () => true }));

import { POST } from "@/app/api/checkout/route";

function checkoutRequest(body: unknown) {
  return new Request("http://localhost/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  designId: DESIGN_ID,
  provider: "stripe",
  email: "buyer@example.com",
  turnstileToken: "turnstile-ok",
  attemptKey: ATTEMPT_KEY,
};

const openSession = {
  id: "cs_test_a1",
  url: "https://checkout.stripe.com/c/pay/cs_test_a1",
  status: "open",
};

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  db.designs.push(
    { id: DESIGN_ID, slug: "royal-mehndi", name: "Royal Mehndi Invite", is_premium: true, price_usd: 1999, price_inr: 149900, active: true },
    { id: FREE_DESIGN_ID, slug: "simple-free", name: "Simple Free Invite", is_premium: false, price_usd: 0, price_inr: 0, active: true }
  );
});

describe("POST /api/checkout (stripe)", () => {
  it("creates a hosted Checkout Session priced from the DB and returns its url", async () => {
    sessionsCreate.mockResolvedValue(openSession);

    const res = await POST(checkoutRequest(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.orderToken).toMatch(/^[a-f0-9]{64}$/);
    expect(json.url).toBe(openSession.url);
    expect(json.clientSecret).toBeUndefined();
    expect(paymentIntentsCreate).not.toHaveBeenCalled();

    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const [params, opts] = sessionsCreate.mock.calls[0];
    expect(params.mode).toBe("payment");
    expect(params.line_items).toEqual([
      {
        price_data: { currency: "usd", product_data: { name: "Royal Mehndi Invite" }, unit_amount: 1999 },
        quantity: 1,
      },
    ]);
    expect(params.client_reference_id).toBe(json.orderToken);
    expect(params.metadata).toEqual({ order_token: json.orderToken, design_id: DESIGN_ID, attempt_key: ATTEMPT_KEY });
    expect(params.customer_email).toBe("buyer@example.com");
    expect(params.success_url).toBe("https://example.com/success");
    expect(params.cancel_url).toBe("https://example.com/editor/royal-mehndi");
    expect(opts).toEqual({ idempotencyKey: ATTEMPT_KEY });

    expect(db.orders).toHaveLength(1);
    expect(db.orders[0]).toMatchObject({
      provider: "stripe",
      provider_ref: "cs_test_a1",
      status: "pending",
      amount: 1999,
      currency: "usd",
      attempt_key: ATTEMPT_KEY,
    });
  });

  it("ignores a client-supplied price — the DB amount wins", async () => {
    sessionsCreate.mockResolvedValue(openSession);

    const res = await POST(checkoutRequest({ ...validBody, price: 1, amount: 1, unit_amount: 1 }));
    expect(res.status).toBe(200);

    const [params] = sessionsCreate.mock.calls[0];
    expect(params.line_items[0].price_data.unit_amount).toBe(1999);
    expect(db.orders[0].amount).toBe(1999);
  });

  it("reuses the open session for a repeated attemptKey — one order, one create", async () => {
    sessionsCreate.mockResolvedValue(openSession);
    const first = await (await POST(checkoutRequest(validBody))).json();

    sessionsRetrieve.mockResolvedValue(openSession);
    const res = await POST(checkoutRequest(validBody));
    expect(res.status).toBe(200);
    const second = await res.json();

    expect(second.orderToken).toBe(first.orderToken);
    expect(second.url).toBe(openSession.url);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    expect(sessionsRetrieve).toHaveBeenCalledWith("cs_test_a1");
    expect(db.orders).toHaveLength(1);
  });

  it("replaces an expired session with a fresh one under a different idempotency key", async () => {
    sessionsCreate.mockResolvedValueOnce({ ...openSession, id: "cs_old", url: "https://checkout.stripe.com/c/pay/cs_old" });
    const first = await (await POST(checkoutRequest(validBody))).json();

    sessionsRetrieve.mockResolvedValue({ id: "cs_old", url: null, status: "expired" });
    sessionsCreate.mockResolvedValueOnce({ ...openSession, id: "cs_new", url: "https://checkout.stripe.com/c/pay/cs_new" });

    const res = await POST(checkoutRequest(validBody));
    expect(res.status).toBe(200);
    const second = await res.json();

    expect(second.orderToken).toBe(first.orderToken);
    expect(second.url).toBe("https://checkout.stripe.com/c/pay/cs_new");
    expect(sessionsCreate).toHaveBeenCalledTimes(2);
    // Reusing attemptKey would make Stripe replay the SAME expired session.
    const [params2, opts2] = sessionsCreate.mock.calls[1];
    expect(params2.line_items[0].price_data.unit_amount).toBe(1999);
    expect(opts2.idempotencyKey).toBeTruthy();
    expect(opts2.idempotencyKey).not.toBe(ATTEMPT_KEY);
    expect(db.orders).toHaveLength(1);
    expect(db.orders[0].provider_ref).toBe("cs_new");
  });

  it("does not create a new session when the previous one already completed", async () => {
    sessionsCreate.mockResolvedValue(openSession);
    const first = await (await POST(checkoutRequest(validBody))).json();

    sessionsRetrieve.mockResolvedValue({ id: "cs_test_a1", url: null, status: "complete" });
    const res = await POST(checkoutRequest(validBody));
    expect(res.status).toBe(200);
    const second = await res.json();

    expect(second).toEqual({ orderToken: first.orderToken, alreadyPaid: true });
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    expect(db.orders).toHaveLength(1);
  });

  it("short-circuits when this email already owns the design — no new charge", async () => {
    const token = "ab".repeat(32);
    db.orders.push({
      id: "orders-paid", order_token: token, design_id: DESIGN_ID, email: "buyer@example.com",
      amount: 1999, currency: "usd", provider: "stripe", provider_ref: "cs_done",
      status: "paid", attempt_key: "99999999-9999-4999-8999-999999999999", paid_at: "2026-01-01T00:00:00Z",
    });
    db.entitlements.push({ id: "entitlements-1", order_id: "orders-paid", revoked: false });

    const res = await POST(checkoutRequest(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orderToken: token, alreadyPaid: true });
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(db.orders).toHaveLength(1);
  });

  it("rejects a free design with 400", async () => {
    const res = await POST(checkoutRequest({ ...validBody, designId: FREE_DESIGN_ID }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "design_is_free" });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["missing attemptKey", { ...validBody, attemptKey: undefined }],
    ["non-uuid designId", { ...validBody, designId: "not-a-uuid" }],
    ["invalid email", { ...validBody, email: "not-an-email" }],
    ["missing turnstileToken", { ...validBody, turnstileToken: undefined }],
    ["empty body", {}],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await POST(checkoutRequest(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});
