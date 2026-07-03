import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Dummy values so route modules (which read process.env at import) load in
    // tests. Signature tests sign with this webhook secret; never real keys.
    env: {
      STRIPE_SECRET_KEY: "sk_test_dummy",
      STRIPE_WEBHOOK_SECRET: "whsec_test_dummy_secret",
      NEXT_PUBLIC_SITE_URL: "https://example.com",
    },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
