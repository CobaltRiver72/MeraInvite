// GET /api/health — liveness probe. Intentionally has NO dependencies, reads no
// env, and touches no DB so it returns 200 even when services are unconfigured.
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
