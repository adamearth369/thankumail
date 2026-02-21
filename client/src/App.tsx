// WHERE TO PASTE: client/src/App.tsx
// ACTION: Full file replacement (paste exactly)

import { Switch, Route } from "wouter";
import { useEffect, useMemo, useState } from "react";

import Home from "./pages/Home";
import Claim from "./pages/Claim";
import TurnstileTool from "./pages/turnstile-tool";
import NotFound from "./pages/not-found";
import Login from "./pages/Login";
import AuthConsume from "./pages/AuthConsume";
import AuthGoogle from "./pages/AuthGoogle";

type VersionInfo = {
  commit: string;
  builtAt: string;
};

function safeGetLS(key: string) {
  try {
    return String(localStorage.getItem(key) || "").trim();
  } catch {
    return "";
  }
}

function safeRemoveLS(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function canonicalizeSessionToken() {
  // Canonical key
  const canonical = safeGetLS("tm_session_token");

  // Legacy keys we want to eliminate
  const legacyKeys = ["tmSessionToken", "sessionToken", "tm_token", "token"];

  // If canonical exists, just clear legacy.
  if (canonical) {
    for (const k of legacyKeys) safeRemoveLS(k);
    return;
  }

  // If canonical is missing but a legacy exists, promote it.
  for (const k of legacyKeys) {
    const v = safeGetLS(k);
    if (v) {
      try {
        localStorage.setItem("tm_session_token", v);
      } catch {}
      // Clear all legacy once promoted
      for (const kk of legacyKeys) safeRemoveLS(kk);
      return;
    }
  }
}

export default function App() {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [apiCommit, setApiCommit] = useState<string>(() => safeGetLS("tm_api_commit"));
  const [apiVersion, setApiVersion] = useState<string>(() => safeGetLS("tm_api_version"));

  // One-time: ensure token key is canonical (prevents old builds from resurrecting a legacy key)
  useEffect(() => {
    canonicalizeSessionToken();
  }, []);

  useEffect(() => {
    fetch("/version.json")
      .then((r) => r.json())
      .then(setVersion)
      .catch(() => {});
  }, []);

  // keep footer in sync as requests happen (same-tab updates won't fire storage event)
  useEffect(() => {
    const id = window.setInterval(() => {
      // Also keep session token key canonical in case any older code tries to write legacy keys
      canonicalizeSessionToken();

      const c = safeGetLS("tm_api_commit");
      const v = safeGetLS("tm_api_version");
      setApiCommit((prev) => (prev !== c ? c : prev));
      setApiVersion((prev) => (prev !== v ? v : prev));
    }, 1000);

    return () => window.clearInterval(id);
  }, []);

  // cross-tab updates
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "tm_api_commit") setApiCommit(safeGetLS("tm_api_commit"));
      if (e.key === "tm_api_version") setApiVersion(safeGetLS("tm_api_version"));
      if (
        e.key === "tm_session_token" ||
        e.key === "tmSessionToken" ||
        e.key === "sessionToken" ||
        e.key === "tm_token" ||
        e.key === "token"
      ) {
        canonicalizeSessionToken();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const frontendShort = useMemo(() => {
    const c = String(version?.commit || "").trim();
    return c ? c.slice(0, 7) : "";
  }, [version]);

  const backendShort = useMemo(() => {
    const c = String(apiCommit || "").trim();
    return c ? c.slice(0, 7) : "";
  }, [apiCommit]);

  return (
    <>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/claim/:publicId" component={Claim} />
        <Route path="/login" component={Login} />
        <Route path="/auth/consume" component={AuthConsume} />
        <Route path="/auth/google" component={AuthGoogle} />
        <Route path="/tools/turnstile" component={TurnstileTool} />
        <Route component={NotFound} />
      </Switch>

      {version && (
        <div
          style={{
            position: "fixed",
            bottom: 6,
            right: 10,
            fontSize: 10,
            opacity: 0.6,
            display: "flex",
            gap: 8,
            alignItems: "center",
            pointerEvents: "none",
          }}
        >
          <span title={version.commit}>fe:{frontendShort || "unknown"}</span>
          <span title={apiCommit || ""}>be:{backendShort || "unknown"}</span>
          {apiVersion ? <span title={apiVersion}>({apiVersion})</span> : null}
        </div>
      )}
    </>
  );
}