import { Switch, Route } from "wouter";
import Home from "./pages/Home";
import Claim from "./pages/Claim";
import TurnstileTool from "./pages/turnstile-tool";
import NotFound from "./pages/not-found";

export default function App() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/claim/:publicId" component={Claim} />
      <Route path="/tools/turnstile" component={TurnstileTool} />
      <Route component={NotFound} />
    </Switch>
  );
}
