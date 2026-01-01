import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AuthGate } from "./components/AuthGate";

function RootLayout() {
  return (
    <div className="app">
      <div className="background">
        <div className="orb orb-one" />
        <div className="orb orb-two" />
        <div className="grid" />
      </div>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: AuthGate
});

const routeTree = rootRoute.addChildren([indexRoute]);

export const router = createRouter({
  routeTree
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}