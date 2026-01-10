import { useRouterState } from "@tanstack/react-router";
import { AdminHeader } from "./AdminHeader";
import { AdminUsers } from "./AdminUsers";
import { SystemUsers } from "./SystemUsers";
import { Videos } from "./Videos";
import { QuotaManagement } from "./QuotaManagement";
import { JobMonitor } from "./JobMonitor";

type Tab = "system-users" | "admin-users" | "videos" | "quotas" | "jobs";

export function Dashboard() {
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
            : pathname.startsWith("/jobs")
              ? "jobs"
              : "system-users";

  const tabCopy: Record<Tab, { title: string; description: string }> = {
    "system-users": {
      title: "用户管理",
      description: "查看所有账户及其关联的 YouTube 凭证。"
    },
    "admin-users": {
      title: "管理员访问",
      description: "管理管理员账户，添加操作员，并保护访问权限。"
    },
    videos: {
      title: "视频管理",
      description: "筛选已同步的视频并按需触发 Gemini 分析。"
    },
    quotas: {
      title: "配额管理",
      description: "查看和管理用户配额，添加授权，发起退款。"
    },
    jobs: {
      title: "任务监控",
      description: "查看 pg-boss 任务队列状态，监控分析任务执行情况。"
    }
  };
  const activeCopy = tabCopy[activeTab];

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <AdminHeader />
      <main className="flex-1 space-y-6 p-6 md:p-8 pt-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-2 align-bottom">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              {activeCopy.title}
            </h1>
            <p className="mt-4 text-sm text-muted-foreground">
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
        ) : activeTab === "jobs" ? (
          <JobMonitor />
        ) : (
          <SystemUsers />
        )}
      </main>
    </div>
  );
}
