import { useMutation, useQuery } from "@tanstack/react-query";
import { fetchJobRuns, fetchSyncRuns, retryJobRun } from "../lib/jobsApi";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Alert, AlertDescription } from "./ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { Activity, AlertTriangle, CheckCircle2, Clock, LogOut, Play, RefreshCw, Shield, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { AdminUsers } from "./AdminUsers";
import { SystemUsers } from "./SystemUsers";

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatDurationMs(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function toNumber(value: unknown) {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

function deriveRunStatus(row: Record<string, unknown>) {
  const total = toNumber(row.job_total);
  if (!total) return String(row.status ?? "unknown");
  const queued = toNumber(row.job_queued);
  const running = toNumber(row.job_running);
  const failed = toNumber(row.job_failed);
  const succeeded = toNumber(row.job_succeeded);
  const skipped = toNumber(row.job_skipped);

  if (queued + running > 0) return "running";
  if (failed > 0) return succeeded + skipped > 0 ? "partial" : "failed";
  return "succeeded";
}

function getResultNumber(result: Record<string, unknown> | null, key: string) {
  return toNumber(result?.[key]);
}

function getRowDurationMs(row: Record<string, unknown>) {
  const result = (row.result as Record<string, unknown> | null) ?? null;
  const durationMs = toNumber(result?.durationMs);
  if (durationMs) return durationMs;
  const started = typeof row.started_at === "string" ? new Date(row.started_at) : null;
  const finished = typeof row.finished_at === "string" ? new Date(row.finished_at) : null;
  if (!started || !finished) return null;
  if (Number.isNaN(started.getTime()) || Number.isNaN(finished.getTime())) return null;
  return finished.getTime() - started.getTime();
}

function getRunDurationMs(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  const startedRaw = (row.job_started_at ?? row.started_at) as string | null | undefined;
  const finishedRaw = (row.job_finished_at ?? row.finished_at) as string | null | undefined;
  if (!startedRaw || !finishedRaw) return null;
  const started = new Date(startedRaw);
  const finished = new Date(finishedRaw);
  if (Number.isNaN(started.getTime()) || Number.isNaN(finished.getTime())) return null;
  return finished.getTime() - started.getTime();
}

function StatusBadge({ status }: { status: string }) {
  const variantMap: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    queued: "outline",
    running: "default",
    succeeded: "secondary",
    failed: "destructive",
    partial: "secondary",
    skipped: "outline"
  };

  return (
    <Badge variant={variantMap[status] || "outline"} className="capitalize">
      {status}
    </Badge>
  );
}

type Tab = "dashboard" | "system-users" | "admin-users";

export function Dashboard() {
  const { session } = useAuth();
  const token = session?.access_token;
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runsPage, setRunsPage] = useState(1);
  const tabCopy: Record<Tab, { eyebrow: string; title: string; description: string }> = {
    dashboard: {
      eyebrow: "Operations",
      title: "YouChannel Control Center",
      description: "Monitor scheduled sync runs, review history, and keep the pipeline healthy."
    },
    "system-users": {
      eyebrow: "Users",
      title: "User Management",
      description: "Review every account and the connected YouTube credentials."
    },
    "admin-users": {
      eyebrow: "Administration",
      title: "Admin Access",
      description: "Manage admin accounts, add operators, and secure access."
    }
  };
  const activeCopy = tabCopy[activeTab];

  const syncRunsQuery = useQuery({
    queryKey: ["sync-runs"],
    enabled: Boolean(token) && activeTab === "dashboard",
    queryFn: () => fetchSyncRuns(token ?? "")
  });

  const retryMutation = useMutation({
    mutationFn: (jobRunId: string) => retryJobRun(token ?? "", jobRunId),
    onSuccess: () => {
      syncRunsQuery.refetch();
      jobRunsQuery.refetch();
    }
  });

  const rows = syncRunsQuery.data?.rows ?? [];
  const totalRuns = rows.length;
  const runsPerPage = 5;
  const totalRunPages = Math.max(1, Math.ceil(totalRuns / runsPerPage));
  const runPageStart = (runsPage - 1) * runsPerPage;
  const runPageEnd = runPageStart + runsPerPage;
  const pagedRuns = rows.slice(runPageStart, runPageEnd);

  useEffect(() => {
    if (!totalRuns && runsPage !== 1) {
      setRunsPage(1);
      return;
    }
    if (runsPage > totalRunPages) {
      setRunsPage(totalRunPages);
    }
  }, [runsPage, totalRunPages, totalRuns]);

  useEffect(() => {
    if (!rows.length) {
      setSelectedRunId(null);
      return;
    }
    const firstId = typeof rows[0]?.id === "string" ? rows[0].id : null;
    if (!selectedRunId || !rows.some((row) => row.id === selectedRunId)) {
      setSelectedRunId(firstId);
    }
  }, [rows, selectedRunId]);

  const jobRunsQuery = useQuery({
    queryKey: ["job-runs", selectedRunId],
    enabled: Boolean(token) && activeTab === "dashboard" && Boolean(selectedRunId),
    queryFn: () => fetchJobRuns(token ?? "", selectedRunId ?? "", 200)
  });

  const counts = rows.reduce(
    (acc, row) => {
      const status = deriveRunStatus(row);
      if (status === "queued") acc.queued += 1;
      if (status === "running") acc.running += 1;
      if (status === "succeeded") acc.succeeded += 1;
      if (status === "failed") acc.failed += 1;
      if (status === "partial") acc.partial += 1;
      return acc;
    },
    { queued: 0, running: 0, succeeded: 0, failed: 0, partial: 0 }
  );

  const activeRuns = counts.queued + counts.running;
  const failedRuns = counts.failed + counts.partial;
  const successRate = totalRuns ? Math.round((counts.succeeded / totalRuns) * 100) : 0;
  const failureRate = totalRuns ? Math.round((failedRuns / totalRuns) * 100) : 0;
  const latestRun = rows[0] as Record<string, unknown> | undefined;
  const latestStatus = latestRun ? deriveRunStatus(latestRun) : "unknown";
  const latestRunId = typeof latestRun?.id === "string" ? latestRun.id : undefined;
  const latestSource = typeof latestRun?.kickoff_source === "string" ? latestRun.kickoff_source : undefined;
  const latestCreatedAt = typeof latestRun?.created_at === "string" ? latestRun.created_at : undefined;
  const latestStartedAt = typeof latestRun?.started_at === "string" ? latestRun.started_at : undefined;
  const latestFinishedAt = typeof latestRun?.finished_at === "string" ? latestRun.finished_at : undefined;
  const latestDurationMs = getRunDurationMs(latestRun);
  const latestJobTotal = toNumber(latestRun?.job_total);
  const latestJobFailed = toNumber(latestRun?.job_failed);
  const latestJobSucceeded = toNumber(latestRun?.job_succeeded);
  const latestJobSkipped = toNumber(latestRun?.job_skipped);

  const jobRows = jobRunsQuery.data?.rows ?? [];
  const jobCounts = jobRows.reduce(
    (acc, row) => {
      const status = String(row.status ?? "");
      if (status === "queued") acc.queued += 1;
      if (status === "running") acc.running += 1;
      if (status === "succeeded") acc.succeeded += 1;
      if (status === "failed") acc.failed += 1;
      if (status === "skipped") acc.skipped += 1;
      return acc;
    },
    { queued: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 }
  );

  const jobTotals = jobRows.reduce(
    (acc, row) => {
      const result = (row.result as Record<string, unknown> | null) ?? null;
      acc.fetched += getResultNumber(result, "fetchedCount");
      acc.newCount += getResultNumber(result, "newCount");
      acc.removed += getResultNumber(result, "removedCount");
      acc.analysesEnqueued += getResultNumber(result, "analysesEnqueued");
      acc.analysesSkipped += getResultNumber(result, "analysesSkipped");
      return acc;
    },
    { fetched: 0, newCount: 0, removed: 0, analysesEnqueued: 0, analysesSkipped: 0 }
  );

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
      value: totalRuns ? failedRuns : 0,
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
              variant={activeTab === "system-users" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setActiveTab("system-users")}
              className="w-full justify-start"
            >
              <Users className="h-4 w-4" />
              Users
            </Button>
            <Button
              variant={activeTab === "admin-users" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setActiveTab("admin-users")}
              className="w-full justify-start"
            >
              <Shield className="h-4 w-4" />
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
              {activeCopy.eyebrow}
            </p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              {activeCopy.title}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {activeCopy.description}
            </p>
          </div>
          {activeTab === "dashboard" && (
            <div className="flex flex-wrap items-center gap-3">
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

        {activeTab === "admin-users" ? (
          <AdminUsers />
        ) : activeTab === "system-users" ? (
          <SystemUsers />
        ) : (
          <>
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
              <div className="space-y-6">
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
                              Jobs
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
                          {totalRuns ? (
                            pagedRuns.map((row) => {
                              const rowId = row.id as string;
                              const derivedStatus = deriveRunStatus(row);
                              const totalJobs = toNumber(row.job_total);
                              const failedJobs = toNumber(row.job_failed);
                              const isSelected = rowId === selectedRunId;
                              return (
                                <TableRow
                                  key={rowId}
                                  onClick={() => setSelectedRunId(rowId)}
                                  className={isSelected ? "bg-muted/40" : "cursor-pointer hover:bg-muted/30"}
                                >
                                  <TableCell className="font-mono text-xs text-muted-foreground">
                                    {rowId.slice(0, 8)}...
                                  </TableCell>
                                  <TableCell>
                                    <StatusBadge status={derivedStatus} />
                                  </TableCell>
                                  <TableCell className="text-sm text-muted-foreground">
                                    {totalJobs ? `${totalJobs} total` : "-"}{failedJobs ? ` / ${failedJobs} failed` : ""}
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
                              );
                            })
                          ) : (
                            <TableRow>
                              <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                                No sync runs yet. Scheduled runs will appear here.
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    )}
                    {!syncRunsQuery.isLoading && !syncRunsQuery.error && totalRuns > 0 && (
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                        <span>
                          Showing {runPageStart + 1}-{Math.min(runPageEnd, totalRuns)} of {totalRuns}
                        </span>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setRunsPage((prev) => Math.max(1, prev - 1))}
                            disabled={runsPage === 1}
                          >
                            Previous
                          </Button>
                          <span>
                            Page {runsPage} of {totalRunPages}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setRunsPage((prev) => Math.min(totalRunPages, prev + 1))}
                            disabled={runsPage === totalRunPages}
                          >
                            Next
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
                  <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <CardTitle>Job Runs</CardTitle>
                      <CardDescription>
                        {selectedRunId ? `Run ${selectedRunId.slice(0, 8)}...` : "Select a run to inspect jobs"}
                      </CardDescription>
                    </div>
                    <Badge variant="secondary">{jobRows.length} jobs</Badge>
                  </CardHeader>
                  <CardContent>
                    {jobRunsQuery.isLoading ? (
                      <div className="space-y-3">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                      </div>
                    ) : jobRunsQuery.error ? (
                      <Alert variant="destructive" className="border-destructive/60 bg-destructive/5">
                        <AlertDescription>
                          Failed to load job runs: {String(jobRunsQuery.error)}
                        </AlertDescription>
                      </Alert>
                    ) : jobRows.length ? (
                      <>
                        <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span>{jobCounts.succeeded} succeeded</span>
                          <span>{jobCounts.failed} failed</span>
                          <span>{jobCounts.running} running</span>
                          <span>{jobCounts.queued} queued</span>
                          <span>{jobCounts.skipped} skipped</span>
                          <span>+{jobTotals.newCount} new</span>
                          <span>-{jobTotals.removed} removed</span>
                          <span>{jobTotals.fetched} fetched</span>
                          <span>{jobTotals.analysesEnqueued} analyses queued</span>
                        </div>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                                Playlist
                              </TableHead>
                              <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                                Status
                              </TableHead>
                              <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                                Attempt
                              </TableHead>
                              <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                                Duration
                              </TableHead>
                              <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                                Counts
                              </TableHead>
                              <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                                Error
                              </TableHead>
                              <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                                Action
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {jobRows.map((row) => {
                              const result = (row.result as Record<string, unknown> | null) ?? null;
                              const playlistId = typeof row.playlist_id === "string" ? row.playlist_id : "-";
                              const fetched = getResultNumber(result, "fetchedCount");
                              const newCount = getResultNumber(result, "newCount");
                              const removed = getResultNumber(result, "removedCount");
                              const analysesQueued = getResultNumber(result, "analysesEnqueued");
                              const analysesSkipped = getResultNumber(result, "analysesSkipped");
                              const durationMs = getRowDurationMs(row);
                              const status = String(row.status ?? "");
                              const httpStatus = toNumber(result?.httpStatus);
                              const error = row.error
                                ? String(row.error)
                                : httpStatus
                                  ? `HTTP ${httpStatus}`
                                  : "-";
                              const canRetry = status === "failed";
                              const isRetrying = retryMutation.isPending && retryMutation.variables === row.id;

                              return (
                                <TableRow key={row.id as string}>
                                  <TableCell className="font-mono text-xs text-muted-foreground">
                                    {playlistId.slice(0, 8)}...
                                  </TableCell>
                                  <TableCell>
                                    <StatusBadge status={status} />
                                  </TableCell>
                                  <TableCell className="text-sm">{row.attempt as number}</TableCell>
                                  <TableCell className="text-sm">
                                    {formatDurationMs(durationMs)}
                                  </TableCell>
                                  <TableCell className="text-xs text-muted-foreground">
                                    <div>+{newCount} / -{removed} / {fetched}</div>
                                    <div>{analysesQueued} queued / {analysesSkipped} skipped</div>
                                  </TableCell>
                                  <TableCell className="text-xs text-muted-foreground">
                                    {error}
                                  </TableCell>
                                  <TableCell>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={!canRetry || isRetrying}
                                      onClick={() => retryMutation.mutate(row.id as string)}
                                    >
                                      {isRetrying ? "Retrying..." : "Retry"}
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border/70 bg-muted/40 p-4 text-sm text-muted-foreground">
                        No jobs for the selected run yet.
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

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
                          <span className="text-muted-foreground">Jobs</span>
                          <span>
                            {latestJobTotal ? `${latestJobSucceeded} ok / ${latestJobFailed} failed / ${latestJobSkipped} skipped` : "-"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Duration</span>
                          <span>{formatDurationMs(latestDurationMs)}</span>
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
                        No sync runs yet. Waiting for the scheduler to run.
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
                      <span className="text-muted-foreground">Partial</span>
                      <Badge variant="outline">{counts.partial}</Badge>
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
                      Scheduled runs will appear automatically. Refresh to update.
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



