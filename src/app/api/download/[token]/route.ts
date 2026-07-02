// GET /api/download/[token]
// The link in the receipt email. Re-checks entitlement on EVERY hit, then
// redirects to a fresh short-lived signed URL of the already-rendered file
// (no re-render here — serves the cached output produced by /api/render).
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { presignGet } from "@/lib/r2";
import { limit, clientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: { token: string } }) {
  if (!(await limit("download", clientIp(req)))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (!/^[a-f0-9]{64}$/.test(params.token)) {
    return NextResponse.json({ error: "bad_token" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: order } = await db
    .from("orders")
    .select("id, status, rendered_key")
    .eq("order_token", params.token)
    .single();
  if (!order || order.status !== "paid") {
    return NextResponse.json({ error: "not_entitled" }, { status: 403 });
  }
  const { data: ent } = await db
    .from("entitlements").select("revoked").eq("order_id", order.id).single();
  if (!ent || ent.revoked) {
    return NextResponse.json({ error: "not_entitled" }, { status: 403 });
  }
  if (!order.rendered_key) {
    // Paid but not rendered yet — client should call /api/render first.
    return NextResponse.json({ error: "not_rendered" }, { status: 409 });
  }

  const url = await presignGet(order.rendered_key, 600);
  return NextResponse.redirect(url, { status: 302 });
}
