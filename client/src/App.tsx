import { Switch, Route } from "wouter";
import { useEffect, useState } from "react";

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

export default function App() {
  const [version, setVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    fetch("/version.json")
      .then(r => r.json())
      .then(setVersion)
      .catch(() => {});
  }, []);

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
        <div style={{
          position: "fixed",
          bottom: 6,
          right: 10,
          fontSize: 10,
          opacity: 0.6
        }}>
          {version.commit.slice(0,7)}
        </div>
      )}
    </>
  );
}