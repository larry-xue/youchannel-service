import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AuthGate } from "./components/AuthGate";

function RootLayout() {
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto py-8 px-4">
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
