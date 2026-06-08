import { type ReactNode } from "react";
import type { Metadata, Viewport } from "next";

// Minimal root layout — no design system yet (that ships on its own branch).
export const metadata: Metadata = {
  title: "MeraInvite",
  description: "Invitation maker — backend scaffold.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
