import { Switch, Route } from "wouter";
import Home from "./pages/Home";
import Claim from "./pages/Claim";
import NotFound from "./pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/claim/:publicId" component={Claim} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return <Router />;
}
