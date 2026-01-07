import { Link, useRouterState } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Film, LogOut, Shield, Users } from "lucide-react";
import { AdminUsers } from "./AdminUsers";
import { SystemUsers } from "./SystemUsers";
import { Videos } from "./Videos";

type Tab = "system-users" | "admin-users" | "videos";

export function Dashboard() {
  const { session } = useAuth();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeTab: Tab =
    pathname === "/" || pathname.startsWith("/users")
      ? "system-users"
      : pathname.startsWith("/admins")
        ? "admin-users"
        : pathname.startsWith("/videos")
          ? "videos"
          : "system-users";

  const tabCopy: Record<Tab, { eyebrow: string; title: string; description: string }> = {
    "system-users": {
      eyebrow: "Users",
      title: "User Management",
      description: "Review every account and the connected YouTube credentials."
    },
    "admin-users": {
      eyebrow: "Administration",
      title: "Admin Access",
      description: "Manage admin accounts, add operators, and secure access."
    },
    videos: {
      eyebrow: "Library",
      title: "Video Management",
      description: "Filter synced videos and trigger Gemini analysis on demand."
    }
  };
  const activeCopy = tabCopy[activeTab];

  return (
    <div className="w-full max-w-full">
      <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="space-y-6">
          <div className="rounded-2xl border border-border/70 bg-card/80 p-5 shadow-sm backdrop-blur">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <span className="text-sm font-semibold">YC</span>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                  YouChannel
                </p>
                <p className="text-lg font-semibold">Admin Console</p>
              </div>
            </div>
            <nav className="mt-6 space-y-1">
              <Button
                asChild
                variant={activeTab === "system-users" ? "secondary" : "ghost"}
                size="sm"
                className="w-full justify-start"
              >
                <Link to="/users">
                  <Users className="h-4 w-4" />
                  Users
                </Link>
              </Button>
              <Button
                asChild
                variant={activeTab === "admin-users" ? "secondary" : "ghost"}
                size="sm"
                className="w-full justify-start"
              >
                <Link to="/admins">
                  <Shield className="h-4 w-4" />
                  Admin Users
                </Link>
              </Button>
              <Button
                asChild
                variant={activeTab === "videos" ? "secondary" : "ghost"}
                size="sm"
                className="w-full justify-start"
              >
                <Link to="/videos">
                  <Film className="h-4 w-4" />
                  Videos
                </Link>
              </Button>
            </nav>
          </div>

          <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Signed in</CardTitle>
              <CardDescription className="truncate">
                {session?.user.email ?? "Admin user"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <span>Role</span>
                <Badge variant="secondary">Administrator</Badge>
              </div>
              <Button variant="outline" onClick={() => supabase.auth.signOut()} className="w-full">
                <LogOut className="h-4 w-4" />
                Sign out
              </Button>
            </CardContent>
          </Card>
        </aside>

        <section className="space-y-6">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                {activeCopy.eyebrow}
              </p>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                {activeCopy.title}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {activeCopy.description}
              </p>
            </div>
          </header>

          {activeTab === "admin-users" ? (
            <AdminUsers />
          ) : activeTab === "videos" ? (
            <Videos />
          ) : (
            <SystemUsers />
          )}
        </section>
      </div>
    </div>
  );
}
