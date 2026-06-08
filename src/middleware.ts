// Security headers on every response + lock /admin to noindex.
// (Heavy CSP also set in next.config.mjs; this catches dynamic routes.)
import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");

  // Never cache API or admin responses.
  if (req.nextUrl.pathname.startsWith("/api") || req.nextUrl.pathname.startsWith("/admin")) {
    res.headers.set("Cache-Control", "no-store, max-age=0");
  }
  if (req.nextUrl.pathname.startsWith("/admin")) {
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  // Token-bearing routes: never leak the URL (with its token) via Referer to
  // CDNs, analytics, or third parties.
  const p = req.nextUrl.pathname;
  if (p.startsWith("/api/download") || p.startsWith("/api/render") || p.startsWith("/success") || p.startsWith("/download")) {
    res.headers.set("Referrer-Policy", "no-referrer");
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
