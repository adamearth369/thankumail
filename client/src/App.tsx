import { Switch, Route, Link, useLocation } from "wouter";
import { useEffect, useMemo, useState } from "react";

import Home from "./pages/Home";
import Claim from "./pages/Claim";
import TurnstileTool from "./pages/turnstile-tool";
import NotFound from "./pages/not-found";
import Login from "./pages/Login";
import AuthGoogle from "./pages/AuthGoogle";
import AuthFacebook from "./pages/AuthFacebook";
import Dashboard from "./pages/Dashboard";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";

const API_BASE = "https://api.thankumail.com";

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

function getQueryParam(name: string) {
  try {
    const u = new URL(window.location.href);
    return String(u.searchParams.get(name) || "").trim();
  } catch {
    return "";
  }
}

async function fetchAuthState(): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/api/auth/me`, {
      method: "GET",
      credentials: "include",
    });

    const j: any = await r.json().catch(() => ({}));
    return Boolean(r.ok && j?.ok);
  } catch {
    return false;
  }
}

function PaySuccess() {
  const [, setLocation] = useLocation();
  const sessionId = getQueryParam("session_id");

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <div className="w-full max-w-lg rounded-2xl border border-tm-charcoal/20 bg-white p-6 shadow-soft text-tm-charcoal">
        <div className="text-xl font-outfit font-semibold">Payment successful.</div>
        <div className="mt-2 text-sm text-tm-charcoal/80">
          {sessionId ? (
            <>
              Stripe session: <span className="font-mono text-[12px]">{sessionId}</span>
            </>
          ) : (
            "Stripe session id missing (session_id)."
          )}
        </div>

        <div className="mt-4 text-sm text-tm-charcoal/80">
          You can return to the home page now. Your gift will be updated as paid once Stripe finishes processing.
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setLocation("/")}
            className="rounded-xl border border-tm-charcoal/20 bg-tm-cream px-3 py-2 text-sm font-medium hover:opacity-90"
          >
            Go home
          </button>

          <Link
            href="/"
            className="rounded-xl border border-tm-charcoal/20 bg-white px-3 py-2 text-sm font-medium hover:bg-tm-cream"
          >
            Home link
          </Link>
        </div>
      </div>
    </div>
  );
}

function PayCancel() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <div className="w-full max-w-lg rounded-2xl border border-tm-charcoal/20 bg-white p-6 shadow-soft text-tm-charcoal">
        <div className="text-xl font-outfit font-semibold">Payment cancelled.</div>
        <div className="mt-2 text-sm text-tm-charcoal/80">
          No charge was completed. You can go back and try again.
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setLocation("/")}
            className="rounded-xl border border-tm-charcoal/20 bg-tm-cream px-3 py-2 text-sm font-medium hover:opacity-90"
          >
            Go home
          </button>
        </div>
      </div>
    </div>
  );
}

function SiteHeader() {
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    let alive = true;

    const sync = async () => {
      const authed = await fetchAuthState();
      if (alive) setHasSession(authed);
    };

    sync();

    const onFocus = () => {
      void sync();
    };

    window.addEventListener("focus", onFocus);

    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return (
    <div className="fixed inset-x-0 top-0 z-50">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link
          href="/"
          className="rounded-xl px-3 py-2 text-sm font-medium text-white/90 transition hover:bg-white/10 hover:text-white"
        >
          Home
        </Link>

        <div className="flex items-center gap-2">
          {hasSession ? (
            <Link
              href="/dashboard"
              className="rounded-xl border border-white/20 bg-white/12 px-4 py-2 text-sm font-medium text-white shadow-soft transition hover:bg-white/18"
            >
              Dashboard
            </Link>
          ) : (
            <Link
              href="/login"
              className="rounded-xl border border-white/20 bg-white/12 px-4 py-2 text-sm font-medium text-white shadow-soft transition hover:bg-white/18"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [apiCommit, setApiCommit] = useState<string>(() => safeGetLS("tm_api_commit"));
  const [apiVersion, setApiVersion] = useState<string>(() => safeGetLS("tm_api_version"));

  useEffect(() => {
    fetch("/version.json")
      .then((r) => r.json())
      .then(setVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      const c = safeGetLS("tm_api_commit");
      const v = safeGetLS("tm_api_version");
      setApiCommit((prev) => (prev !== c ? c : prev));
      setApiVersion((prev) => (prev !== v ? v : prev));
    }, 1000);

    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "tm_api_commit") setApiCommit(safeGetLS("tm_api_commit"));
      if (e.key === "tm_api_version") setApiVersion(safeGetLS("tm_api_version"));
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
      <SiteHeader />

      <Switch>
        <Route path="/" component={Home} />
        <Route path="/claim/:publicId" component={Claim} />
        <Route path="/login" component={Login} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/terms" component={Terms} />
        <Route path="/privacy" component={Privacy} />
        <Route path="/auth/google" component={AuthGoogle} />
        <Route path="/auth/google/success" component={AuthGoogle} />
        <Route path="/auth/facebook" component={AuthFacebook} />

        <Route path="/pay/success" component={PaySuccess} />
        <Route path="/pay/cancel" component={PayCancel} />

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