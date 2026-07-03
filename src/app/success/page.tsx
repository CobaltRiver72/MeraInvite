"use client";
// Functional stub — plain text, no design system (the real UI ships on the
// front-end branch). After a hosted-Checkout redirect the browser lands here; we
// resume from the localStorage order token, poll the status route until `paid`,
// then offer the download. Payment truth comes ONLY from the server status, never
// a `?paid=true` in the URL.
import { useCallback, useEffect, useState } from "react";

const TOKEN_KEY = "orderToken";
const POLL_MS = 2500;

type Phase = "loading" | "no_order" | "pending" | "paid" | "closed" | "downloading" | "done" | "error";

export default function SuccessPage() {
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (!stored) {
      setPhase("no_order");
      return;
    }
    setToken(stored);
    setPhase("pending");
  }, []);

  // Poll coarse status until the order is paid or reaches a terminal state.
  useEffect(() => {
    if (!token || phase !== "pending") return;
    let active = true;

    async function poll() {
      try {
        const res = await fetch(`/api/orders/${token}/status`, { cache: "no-store" });
        if (!active) return;
        if (!res.ok) return; // transient (429/404 before the row lands) — keep polling
        const { status } = (await res.json()) as { status: string };
        if (status === "paid") setPhase("paid");
        else if (status === "refunded" || status === "expired" || status === "failed") setPhase("closed");
      } catch {
        /* network blip — the interval retries */
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [token, phase]);

  const download = useCallback(async () => {
    if (!token) return;
    setPhase("downloading");
    try {
      // The download route re-checks entitlement, then 302s to a signed URL.
      const res = await fetch(`/api/download/${token}`);
      if (res.status === 409) {
        setPhase("paid");
        setMessage("Your file is still being prepared — try again in a moment.");
        return;
      }
      if (!res.ok) {
        setPhase("paid");
        setMessage("Download unavailable. Check the link we emailed you.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "invitation.png";
      a.click();
      URL.revokeObjectURL(url);
      localStorage.removeItem(TOKEN_KEY); // clear only after a successful download
      setPhase("done");
    } catch {
      setPhase("paid");
      setMessage("Something went wrong. Check the link we emailed you.");
    }
  }, [token]);

  return (
    <main>
      {phase === "loading" && <p>Loading…</p>}
      {phase === "no_order" && <p>No recent order found in this browser. Check the link we emailed you.</p>}
      {phase === "pending" && <p>Confirming your payment…</p>}
      {(phase === "paid" || phase === "downloading") && (
        <div>
          <p>Payment confirmed. Your invitation is ready.</p>
          <button onClick={download} disabled={phase === "downloading"}>
            {phase === "downloading" ? "Preparing…" : "Download"}
          </button>
          {message && <p>{message}</p>}
        </div>
      )}
      {phase === "done" && <p>Downloaded. You can also re-download from the link we emailed you.</p>}
      {phase === "closed" && <p>This order is no longer available.</p>}
      {phase === "error" && <p>Something went wrong. Check the link we emailed you.</p>}
    </main>
  );
}
