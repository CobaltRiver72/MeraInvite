// Next.js instrumentation hook — runs once when a server instance boots.
// (1) Validate env at boot so a missing required secret fails fast and loud
//     (importing @/lib/env runs its zod parse).
// (2) Initialize Sentry for the active runtime.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@/lib/env");
    await import("../sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}
