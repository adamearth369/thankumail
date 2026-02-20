import { Switch, Route } from "wouter";

import Home from "./pages/Home";
import Claim from "./pages/Claim";
import TurnstileTool from "./pages/turnstile-tool";
import NotFound from "./pages/not-found";

import Login from "./pages/Login";
import AuthConsume from "./pages/AuthConsume";
import AuthGoogle from "./pages/AuthGoogle";

export default function App() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/claim/:publicId" component={Claim} />

      <Route path="/login" component={Login} />
      <Route path="/auth/consume" component={AuthConsume} />
      <Route path="/auth/google" component={AuthGoogle} />

      <Route path="/tools/turnstile" component={TurnstileTool} />

      <Route component={NotFound} />
    </Switch>
  );
}