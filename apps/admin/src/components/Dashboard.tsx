import { useMutation, useQuery } from "@tanstack/react-query";
import { kickoff, fetchSyncRuns } from "../lib/jobsApi";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Alert, AlertDescription } from "./ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { Activity, AlertTriangle, CheckCircle2, Clock, LogOut, Play, RefreshCw, Users } from "lucide-react";
import { useState } from "react";
import { AdminUsers } from "./AdminUsers";

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function StatusBadge({ status }: { status: string }) {
  const variantMap: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    queued: "outline",
    running: "default",
    succeeded: "secondary",
    failed: "destructive",
  };

  return (
    <Badge variant={variantMap[status] || "outline"} className="capitalize">
      {status}
    </Badge>
  );
}

type Tab = "dashboard" | "users";

export function Dashboard() {
  const { session } = useAuth();
  const token = session?.access_token;
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");

  const syncRunsQuery = useQuery({
    queryKey: ["sync-runs"],
    enabled: Boolean(token) && activeTab === "dashboard",
    queryFn: () => fetchSyncRuns(token ?? "")
  });

  const kickoffMutation = useMutation({
    mutationFn: () => kickoff(token ?? ""),
    onSuccess: () => syncRunsQuery.refetch()
  });

  const rows = syncRunsQuery.data?.rows ?? [];
  const totalRuns = rows.length;
  const counts = rows.reduce(
    (acc, row) => {
      const status = String(row.status ?? "");
      if (status === "queued") acc.queued += 1;
      if (status === "running") acc.running += 1;
      if (status === "succeeded") acc.succeeded += 1;
      if (status === "failed") acc.failed += 1;
      return acc;
    },
    { queued: 0, running: 0, succeeded: 0, failed: 0 }
  );

  const activeRuns = counts.queued + counts.running;
  const successRate = totalRuns ? Math.round((counts.succeeded / totalRuns) * 100) : 0;
  const failureRate = totalRuns ? Math.round((counts.failed / totalRuns) * 100) : 0;
  const latestRun = rows[0] as Record<string, unknown> | undefined;
  const latestStatus = typeof latestRun?.status === "string" ? latestRun.status : "unknown";
  const latestRunId = typeof latestRun?.id === "string" ? latestRun.id : undefined;
  const latestSource = typeof latestRun?.kickoff_source === "string" ? latestRun.kickoff_source : undefined;
  const latestCreatedAt = typeof latestRun?.created_at === "string" ? latestRun.created_at : undefined;
  const latestStartedAt = typeof latestRun?.started_at === "string" ? latestRun.started_at : undefined;
  const latestFinishedAt = typeof latestRun?.finished_at === "string" ? latestRun.finished_at : undefined;

  const summaryCards = [
    {
      label: "Total runs",
      value: totalRuns,
      detail: "Last 50 sync runs",
      icon: Activity
    },
    {
      label: "Active queue",
      value: activeRuns,
      detail: totalRuns ? `${counts.queued} queued, ${counts.running} running` : "No jobs queued",
      icon: Play
    },
    {
      label: "Success rate",
      value: totalRuns ? `${successRate}%` : "--",
      detail: `${counts.succeeded} succeeded`,
      icon: CheckCircle2
    },
    {
      label: "Failed runs",
      value: totalRuns ? counts.failed : 0,
      detail: totalRuns ? `${failureRate}% of recent runs` : "No recent failures",
      icon: AlertTriangle
    }
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
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
              variant={activeTab === "dashboard" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setActiveTab("dashboard")}
              className="w-full justify-start"
            >
              <Activity className="h-4 w-4" />
              Dashboard
            </Button>
            <Button
              variant={activeTab === "users" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setActiveTab("users")}
              className="w-full justify-start"
            >
              <Users className="h-4 w-4" />
              Admin Users
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
              {activeTab === "dashboard" ? "Operations" : "Administration"}
            </p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              {activeTab === "dashboard" ? "YouChannel Control Center" : "Admin Access"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {activeTab === "dashboard"
                ? "Queue sync runs, review history, and keep the pipeline healthy."
                : "Manage admin accounts, add operators, and secure access."}
            </p>
          </div>
          {activeTab === "dashboard" && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => kickoffMutation.mutate()}
                disabled={kickoffMutation.isPending}
                size="lg"
              >
                <Play className="h-4 w-4" />
                {kickoffMutation.isPending ? "Enqueuing..." : "Kickoff Sync"}
              </Button>
              <Button
                variant="outline"
                onClick={() => syncRunsQuery.refetch()}
                disabled={syncRunsQuery.isFetching}
                size="lg"
              >
                <RefreshCw className={syncRunsQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                Refresh
              </Button>
            </div>
          )}
        </header>

        {activeTab === "users" ? (
          <AdminUsers />
        ) : (
          <>
            {kickoffMutation.error && (
              <Alert variant="destructive" className="border-destructive/60 bg-destructive/5">
                <AlertDescription>
                  Kickoff failed: {String(kickoffMutation.error)}
                </AlertDescription>
              </Alert>
            )}

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {summaryCards.map((card, index) => (
                <Card
                  key={card.label}
                  className="relative overflow-hidden border-border/70 bg-card/80 shadow-sm backdrop-blur motion-safe:animate-[fade-up_0.5s_ease-out]"
                  style={{ animationDelay: `${index * 80}ms`, animationFillMode: "both" }}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardDescription className="text-xs font-semibold uppercase tracking-[0.2em]">
                        {card.label}
                      </CardDescription>
                      <card.icon className="h-4 w-4 text-muted-foreground" />
                    </div>
                    {syncRunsQuery.isLoading ? (
                      <Skeleton className="h-8 w-24" />
                    ) : (
                      <CardTitle className="text-3xl font-semibold tracking-tight">
                        {card.value}
                      </CardTitle>
                    )}
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    {card.detail}
                  </CardContent>
                  <div className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full bg-primary/10 blur-2xl" />
                </Card>
              ))}
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
                <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle>Recent Sync Runs</CardTitle>
                    <CardDescription>View the history of sync job executions</CardDescription>
                  </div>
                  <Badge variant="secondary">{totalRuns} runs</Badge>
                </CardHeader>
                <CardContent>
                  {syncRunsQuery.isLoading ? (
                    <div className="space-y-3">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : syncRunsQuery.error ? (
                    <Alert variant="destructive" className="border-destructive/60 bg-destructive/5">
                      <AlertDescription>
                        Failed to load runs: {String(syncRunsQuery.error)}
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                            ID
                          </TableHead>
                          <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                            Status
                          </TableHead>
                          <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                            Source
                          </TableHead>
                          <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                            Created
                          </TableHead>
                          <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                            Started
                          </TableHead>
                          <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                            Finished
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {syncRunsQuery.data?.rows?.length ? (
                          syncRunsQuery.data.rows.map((row) => (
                            <TableRow key={row.id as string}>
                              <TableCell className="font-mono text-xs text-muted-foreground">
                                {(row.id as string).slice(0, 8)}...
                              </TableCell>
                              <TableCell>
                                <StatusBadge status={row.status as string} />
                              </TableCell>
                              <TableCell className="text-sm">
                                {row.kickoff_source as string}
                              </TableCell>
                              <TableCell className="text-sm">
                                {formatTime(row.created_at as string)}
                              </TableCell>
                              <TableCell className="text-sm">
                                {formatTime(row.started_at as string)}
                              </TableCell>
                              <TableCell className="text-sm">
                                {formatTime(row.finished_at as string)}
                              </TableCell>
                            </TableRow>
                          ))
                        ) : (
                          <TableRow>
                            <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                              No sync runs yet. Kick one off to begin.
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <div className="space-y-6">
                <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
                  <CardHeader>
                    <CardTitle>Latest Run</CardTitle>
                    <CardDescription>Most recent sync execution snapshot</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {latestRun ? (
                      <>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Status</span>
                          <StatusBadge status={latestStatus} />
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Run ID</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {latestRunId ? `${latestRunId.slice(0, 8)}...` : "-"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Source</span>
                          <span>{latestSource ?? "-"}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Created</span>
                          <span>{formatTime(latestCreatedAt)}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Started</span>
                          <span>{formatTime(latestStartedAt)}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Finished</span>
                          <span>{formatTime(latestFinishedAt)}</span>
                        </div>
                      </>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border/70 bg-muted/40 p-4 text-sm text-muted-foreground">
                        No sync runs yet. Start the first run to populate live metrics.
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      Pipeline Health
                    </CardTitle>
                    <CardDescription>Current status from the last 50 runs</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Queued</span>
                      <Badge variant="secondary">{counts.queued}</Badge>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Running</span>
                      <Badge variant="secondary">{counts.running}</Badge>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Failed</span>
                      <Badge variant="outline">{counts.failed}</Badge>
                    </div>
                    <div>
                      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                        <span>Success rate</span>
                        <span>{totalRuns ? `${successRate}%` : "--"}</span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-muted/60">
                        <div
                          className="h-2 rounded-full bg-primary transition-all"
                          style={{ width: totalRuns ? `${successRate}%` : "0%" }}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Use the control panel to queue new sync runs.
                    </p>
                  </CardContent>
                </Card>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
