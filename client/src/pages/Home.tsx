// client/src/pages/Home.tsx
import React, { useEffect, useMemo, useState } from "react";
import CreateGiftForm from "../components/CreateGiftForm";

function getLastLinkKey() {
  return "thankumail:lastClaimUrl";
}

function safeGetLastClaimUrl() {
  try {
    return localStorage.getItem(getLastLinkKey()) || "";
  } catch {
    return "";
  }
}

function safeSetLastClaimUrl(url: string) {
  try {
    localStorage.setItem(getLastLinkKey(), url);
  } catch {
    // ignore
  }
}

function isValidHttpUrl(s: string) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export default function Home() {
  const [lastUrl, setLastUrl] = useState("");

  useEffect(() => {
    setLastUrl(safeGetLastClaimUrl());
  }, []);

  const hasLast = useMemo(() => isValidHttpUrl(lastUrl), [lastUrl]);

  function copyLast() {
    if (!hasLast) return;
    navigator.clipboard?.writeText(lastUrl).catch(() => {});
  }

  function openLast() {
    if (!hasLast) return;
    window.location.href = lastUrl;
  }

  // Optional: keep last link in sync if CreateGiftForm stores it (common pattern)
  // If your CreateGiftForm already calls localStorage.setItem("thankumail:lastClaimUrl", claimUrl)
  // then the next refresh shows it. If you want it to live-update immediately, we can wire a callback later.

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px" }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 36, fontWeight: 900, letterSpacing: -0.5 }}>ThanküMail</div>
        <div style={{ marginTop: 6, fontSize: 16, opacity: 0.9 }}>Send a gift with a real message.</div>

        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 28, fontWeight: 900 }}>A small gift. A message they’ll remember.</div>
          <div style={{ marginTop: 8, fontSize: 16, opacity: 0.9 }}>
            Your words arrive first. The gift follows when they’re ready.
          </div>
        </div>
      </div>

      <div style={{ marginTop: 18, padding: 14, border: "1px solid #e6e6e6", borderRadius: 14 }}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Last ThanküMail link</div>

        {!hasLast ? (
          <div style={{ opacity: 0.8 }}>None yet.</div>
        ) : (
          <>
            <div style={{ wordBreak: "break-all" }}>{lastUrl}</div>
            <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" onClick={copyLast}>
                Copy link
              </button>
              <button type="button" onClick={openLast}>
                Open claim page →
              </button>
            </div>
          </>
        )}

        <div style={{ marginTop: 10, fontSize: 13, opacity: 0.75 }}>
          Tip: This saves your latest link in your browser so you can grab it again easily.
        </div>
      </div>

      <div style={{ marginTop: 26 }}>
        <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 10 }}>Create a ThanküMail</div>
        <CreateGiftForm />
      </div>
    </div>
  );
}
