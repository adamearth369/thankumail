// client/src/pages/Home.tsx
import React, { useEffect, useMemo, useState } from "react";
import CreateGiftForm from "../components/CreateGiftForm";

type LastLink = {
  claimUrl: string;
  createdAt: number; // ms
};

const STORAGE_KEY = "thankumail:lastClaim";
const EXPIRE_MS = 24 * 60 * 60 * 1000; // 24h

function safeParse(raw: string | null): LastLink | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.claimUrl !== "string" || !obj.claimUrl) return null;
    if (typeof obj.createdAt !== "number" || !Number.isFinite(obj.createdAt)) return null;
    return obj as LastLink;
  } catch {
    return null;
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

function readLastLink(): LastLink | null {
  try {
    // Back-compat: if older key exists, migrate it.
    const legacy = localStorage.getItem("thankumail:lastClaimUrl") || "";
    const legacyOk = legacy && isValidHttpUrl(legacy);

    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = safeParse(raw);

    if (parsed) {
      const age = Date.now() - parsed.createdAt;
      if (age > EXPIRE_MS) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      // If legacy exists but differs, prefer new structured one.
      return parsed;
    }

    if (legacyOk) {
      const migrated: LastLink = { claimUrl: legacy, createdAt: Date.now() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      // leave legacy key in place; harmless
      return migrated;
    }

    return null;
  } catch {
    return null;
  }
}

async function copyToClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {}
  // fallback
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "true");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {}
}

function ageLabel(createdAtMs: number) {
  const mins = Math.floor((Date.now() - createdAtMs) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return "recently";
}

export default function Home() {
  const [last, setLast] = useState<LastLink | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLast(readLastLink());
  }, []);

  const hasLast = useMemo(() => !!last && isValidHttpUrl(last.claimUrl), [last]);

  async function copyLast() {
    if (!hasLast || !last) return;
    await copyToClipboard(last.claimUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  function openLast() {
    if (!hasLast || !last) return;
    window.location.href = last.claimUrl;
  }

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
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Last ThanküMail link</div>
          {hasLast && last ? <div style={{ fontSize: 12, opacity: 0.7 }}>{ageLabel(last.createdAt)}</div> : null}
        </div>

        {!hasLast || !last ? (
          <div style={{ opacity: 0.8 }}>None yet.</div>
        ) : (
          <>
            <div style={{ wordBreak: "break-all", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
              {last.claimUrl}
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" onClick={copyLast}>
                {copied ? "Copied" : "Copy link"}
              </button>
              <button type="button" onClick={openLast}>
                Open claim page →
              </button>
            </div>
          </>
        )}

        <div style={{ marginTop: 10, fontSize: 13, opacity: 0.75 }}>
          Tip: This saves your latest link in your browser (on this device) and clears after a day.
        </div>
      </div>

      <div style={{ marginTop: 26 }}>
        <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 10 }}>Create a ThanküMail</div>
        <CreateGiftForm />
      </div>
    </div>
  );
}
