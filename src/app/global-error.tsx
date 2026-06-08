"use client";

// App Router global error boundary — reports React render errors to Sentry.
// Plain text only (no design system yet).
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>Something went wrong.</body>
    </html>
  );
}
