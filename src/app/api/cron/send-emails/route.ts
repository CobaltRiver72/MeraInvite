// GET /api/cron/send-emails — drains the pending_emails outbox so payment success
// is never blocked on email delivery. Run ~every minute (Vercel Cron / external).
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { sendEmail } from "@/lib/email";
import { isAuthorizedCron } from "@/lib/cron";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const site = process.env.NEXT_PUBLIC_SITE_URL!;
  const { data: rows } = await db
    .from("pending_emails")
    .select("id, to_email, subject, body, attempts, orders!inner(order_token)")
    .in("status", ["pending", "failed"])
    .lt("attempts", 5)
    .limit(50);

  let sent = 0, failed = 0;
  for (const r of rows ?? []) {
    await db.from("pending_emails").update({ status: "processing" }).eq("id", r.id);
    const token = (r as any).orders?.order_token as string | undefined;
    const url = token ? `${site}/api/download/${token}` : site;
    const html = String(r.body).replaceAll("{{DOWNLOAD_URL}}", url);
    const ok = await sendEmail(r.to_email, r.subject, html);
    await db.from("pending_emails").update({
      status: ok ? "sent" : "failed",
      attempts: r.attempts + 1,
      last_attempt_at: new Date().toISOString(),
    }).eq("id", r.id);
    ok ? sent++ : failed++;
  }
  return NextResponse.json({ sent, failed });
}
