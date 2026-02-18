// WHERE TO PASTE: client/src/App.tsx
// ACTION: Full file replacement

import { Switch, Route } from "wouter";

import Home from "./pages/Home";
import Claim from "./pages/Claim";
import TurnstileTool from "./pages/turnstile-tool";
import NotFound from "./pages/not-found";

// FIX: correct folder (Render Linux build is case-sensitive)
import Login from "./pages/Login";
import AuthConsume from "./pages/AuthConsume";

export default function App() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/claim/:publicId" component={Claim} />

      {/* Registered user flow */}
      <Route path="/login" component={Login} />
      <Route path="/auth/consume" component={AuthConsume} />

      {/* Tools */}
      <Route path="/tools/turnstile" component={TurnstileTool} />

      <Route component={NotFound} />
    </Switch>
  );
}
