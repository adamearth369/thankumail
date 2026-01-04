import { Switch, Route } from "wouter";
import Landing from "./pages/landing";
import ClaimGift from "./pages/ClaimGift";
import NotFound from "./pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/claim/:publicId" component={ClaimGift} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return <Router />;
}
