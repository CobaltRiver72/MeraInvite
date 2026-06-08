// POST /api/render  { orderToken, text }
// Premium only. Verifies PAID + entitled, then composites the CLEAN private
// master + the user's text at full print resolution using Satori + resvg
// (pure JS/Rust-WASM — ~50-200ms, no headless Chrome, fits serverless limits).
// Result is cached in the private bucket keyed by a hash of the text, so the
// same text never re-renders (cheap) and editing text busts the cache.
import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "node:crypto";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { supabaseAdmin } from "@/lib/supabase";
import { getPrivateObject, putPrivateObject, presignGet, privateObjectExists } from "@/lib/r2";
import { loadFonts } from "@/lib/fonts";
import { limit, clientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({
  orderToken: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.array(z.object({ id: z.string().max(64), value: z.string().max(400) })).max(20),
});

type Field = {
  id: string; xPct: number; yPct: number; fontFamily?: string; fontSizePct: number;
  color?: string; textAlign?: "left" | "center" | "right"; maxWidthPct?: number;
};

export async function POST(req: Request) {
  if (!(await limit("render", clientIp(req)))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const db = supabaseAdmin();

  // Entitlement: order must be paid + not revoked.
  const { data: order } = await db
    .from("orders").select("id, design_id, status").eq("order_token", body.orderToken).single();
  if (!order || order.status !== "paid") {
    return NextResponse.json({ error: "not_entitled" }, { status: 403 });
  }
  const { data: ent } = await db
    .from("entitlements").select("revoked").eq("order_id", order.id).eq("design_id", order.design_id).single();
  if (!ent || ent.revoked) {
    return NextResponse.json({ error: "not_entitled" }, { status: 403 });
  }

  const { data: design } = await db
    .from("designs").select("width, height, text_fields").eq("id", order.design_id).single();
  const { data: asset } = await db
    .from("design_assets").select("master_key").eq("design_id", order.design_id).single();
  if (!design || !asset) return NextResponse.json({ error: "server_error" }, { status: 500 });

  // Cache key: same text => same file => no recompute. New text => new key.
  const textHash = crypto.createHash("sha256").update(JSON.stringify(body.text)).digest("hex").slice(0, 16);
  const outKey = `rendered/${order.id}/${textHash}.png`;

  if (!(await privateObjectExists(outKey))) {
    const bg = await getPrivateObject(asset.master_key); // clean master — server only
    const png = await composite(design.width, design.height, design.text_fields as Field[], body.text, bg);
    await putPrivateObject(outKey, png, "image/png");
  }

  // Point the order at the latest render so /api/download serves it.
  await db.from("orders").update({ rendered_key: outKey }).eq("id", order.id);

  const url = await presignGet(outKey, 600); // 10-min link
  return NextResponse.json({ url });
}

async function composite(
  W: number, H: number, fields: Field[],
  values: { id: string; value: string }[], bg: Buffer
): Promise<Buffer> {
  const byId = Object.fromEntries(values.map((v) => [v.id, v.value]));
  const base64 = bg.toString("base64");

  const svg = await satori(
    // satori accepts this vnode object at runtime; its React typings are stricter.
    ({
      type: "div",
      props: {
        style: { display: "flex", position: "relative", width: `${W}px`, height: `${H}px` },
        children: [
          {
            type: "img",
            props: {
              src: `data:image/png;base64,${base64}`,
              style: { position: "absolute", top: 0, left: 0, width: `${W}px`, height: `${H}px` },
            },
          },
          ...fields.map((f) => ({
            type: "div",
            props: {
              style: {
                position: "absolute",
                left: `${f.xPct}%`,
                top: `${f.yPct}%`,
                transform: `translate(${f.textAlign === "center" ? "-50%" : f.textAlign === "right" ? "-100%" : "0"}, -50%)`,
                width: `${f.maxWidthPct ?? 80}%`,
                fontSize: `${(f.fontSizePct / 100) * W}px`,
                fontFamily: f.fontFamily ?? "display",
                color: f.color ?? "#1f3d2f",
                textAlign: f.textAlign ?? "center",
                display: "flex",
                justifyContent:
                  f.textAlign === "right" ? "flex-end" : f.textAlign === "left" ? "flex-start" : "center",
                whiteSpace: "pre-wrap",
                lineHeight: 1.2,
              },
              // string child => Satori renders it as TEXT (no HTML parsing / no script execution)
              children: String(byId[f.id] ?? ""),
            },
          })),
        ],
      },
    }) as unknown as Parameters<typeof satori>[0],
    { width: W, height: H, fonts: loadFonts() }
  );

  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: W } });
  return Buffer.from(resvg.render().asPng());
}
