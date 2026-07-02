// GET /api/orders/[token]/status -> { status } only. No PII. Used by the browser
// to resume after a reconnect/crash and decide when to render+download.
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { limit, clientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: { token: string } }) {
  if (!(await limit("status", clientIp(req)))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (!/^[a-f0-9]{64}$/.test(params.token)) {
    return NextResponse.json({ error: "bad_token" }, { status: 400 });
  }
  const db = supabaseAdmin();
  const { data: order } = await db
    .from("orders").select("status").eq("order_token", params.token).maybeSingle();
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Only expose coarse status — never amount/email/etc.
  return NextResponse.json({ status: order.status }, { headers: { "Cache-Control": "no-store" } });
}
