import { Link, useRouterState } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Film, LogOut, Shield, Users, Coins } from "lucide-react";
import { AdminUsers } from "./AdminUsers";
import { SystemUsers } from "./SystemUsers";
import { Videos } from "./Videos";
import { QuotaManagement } from "./QuotaManagement";

type Tab = "system-users" | "admin-users" | "videos" | "quotas";

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
          : pathname.startsWith("/quotas")
            ? "quotas"
            : "system-users";

  const tabCopy: Record<Tab, { eyebrow: string; title: string; description: string }> = {
    "system-users": {
      eyebrow: "用户",
      title: "用户管理",
      description: "查看所有账户及其关联的 YouTube 凭证。"
    },
    "admin-users": {
      eyebrow: "管理",
      title: "管理员访问",
      description: "管理管理员账户，添加操作员，并保护访问权限。"
    },
    videos: {
      eyebrow: "视频库",
      title: "视频管理",
      description: "筛选已同步的视频并按需触发 Gemini 分析。"
    },
    quotas: {
      eyebrow: "配额管理",
      title: "配额管理",
      description: "查看和管理用户配额，添加授权，发起退款。"
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
                <p className="text-lg font-semibold">管理控制台</p>
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
                  用户
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
                  管理员用户
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
                  视频
                </Link>
              </Button>
              <Button
                asChild
                variant={activeTab === "quotas" ? "secondary" : "ghost"}
                size="sm"
                className="w-full justify-start"
              >
                <Link to="/quotas" search={{ userId: undefined }}>
                  <Coins className="h-4 w-4" />
                  配额
                </Link>
              </Button>
            </nav>
          </div>

          <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">已登录</CardTitle>
              <CardDescription className="truncate">
                {session?.user.email ?? "管理员用户"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <span>角色</span>
                <Badge variant="secondary">管理员</Badge>
              </div>
              <Button variant="outline" onClick={() => supabase.auth.signOut()} className="w-full">
                <LogOut className="h-4 w-4" />
                退出登录
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
          ) : activeTab === "quotas" ? (
            <QuotaManagement />
          ) : (
            <SystemUsers />
          )}
        </section>
      </div>
    </div>
  );
}
