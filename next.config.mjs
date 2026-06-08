// Content-Security-Policy: allow self + only the third parties we actually use.
// Tighten/extend the allowlist as you add providers. Test at securityheaders.com.
import { withSentryConfig } from "@sentry/nextjs";

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com https://checkout.razorpay.com https://challenges.cloudflare.com",
  "frame-src https://js.stripe.com https://hooks.stripe.com https://api.razorpay.com https://challenges.cloudflare.com",
  // connect-src includes Sentry ingest so client error reporting isn't blocked.
  "connect-src 'self' https://api.stripe.com https://*.razorpay.com https://*.supabase.co https://*.upstash.io https://*.ingest.sentry.io https://*.ingest.us.sentry.io",
  "img-src 'self' data: https:",                  // CDN previews + free backgrounds
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false, // don't advertise the framework
  experimental: {
    instrumentationHook: true, // enables src/instrumentation.ts (env validation + Sentry)
    // @resvg/resvg-js ships a native .node binary — keep it external so webpack
    // requires it at runtime instead of trying to bundle (and choking on) it.
    serverComponentsExternalPackages: ["@resvg/resvg-js"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Content-Security-Policy", value: csp }],
      },
    ];
  },
};

// withSentryConfig wires source-map upload + the client config. With no auth
// token (local/CI/preview without a Sentry token) it silently skips upload, so
// the build stays green.
export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  widenClientFileUpload: true,
});
