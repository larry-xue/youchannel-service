import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AuthGate } from "./components/AuthGate";
import { Dashboard } from "./components/Dashboard";

function RootLayout() {
  return (
    <div className="relative min-h-screen bg-background font-sans text-foreground">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-32 right-0 h-72 w-72 rounded-full bg-primary/20 blur-3xl motion-safe:animate-[float_8s_ease-in-out_infinite]" />
        <div className="absolute bottom-0 left-0 h-72 w-72 rounded-full bg-accent/20 blur-3xl motion-safe:animate-[float_10s_ease-in-out_infinite]" />
      </div>
      <main className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-10 motion-safe:animate-[page-in_0.6s_ease-out]">
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout
});

const authRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "auth",
  component: AuthGate
});

const dashboardRoute = createRoute({
  getParentRoute: () => authRoute,
  path: "/",
  component: Dashboard
});

const systemUsersRoute = createRoute({
  getParentRoute: () => authRoute,
  path: "users",
  component: Dashboard
});

const adminUsersRoute = createRoute({
  getParentRoute: () => authRoute,
  path: "admins",
  component: Dashboard
});

const videosRoute = createRoute({
  getParentRoute: () => authRoute,
  path: "videos",
  component: Dashboard
});

const routeTree = rootRoute.addChildren([
  authRoute.addChildren([dashboardRoute, systemUsersRoute, adminUsersRoute, videosRoute])
]);

export const router = createRouter({
  routeTree
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
