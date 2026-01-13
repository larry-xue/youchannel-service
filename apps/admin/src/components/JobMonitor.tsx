import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";
import { useAuth } from "@/lib/auth";
import {
  fetchJobStats,
  fetchJobList,
  type JobRow,
  type JobListParams
} from "@/lib/jobsApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { RefreshCw, Loader2, Clock, CheckCircle2, XCircle, Play, RotateCcw, Archive } from "lucide-react";

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatDuration(startTime: string | null, endTime: string | null) {
  if (!startTime || !endTime) return "-";
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return "-";
  const durationMs = end - start;
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${(durationMs / 60000).toFixed(1)}m`;
}

type StateConfig = {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
  icon: React.ElementType;
};

const stateConfigs: Record<string, StateConfig> = {
  created: { label: "待处理", variant: "outline", icon: Clock },
  active: { label: "执行中", variant: "default", icon: Play },
  completed: { label: "已完成", variant: "secondary", icon: CheckCircle2 },
  failed: { label: "失败", variant: "destructive", icon: XCircle },
  retry: { label: "重试中", variant: "outline", icon: RotateCcw },
  expired: { label: "已过期", variant: "destructive", icon: Clock },
  cancelled: { label: "已取消", variant: "secondary", icon: XCircle },
  archived: { label: "已归档", variant: "secondary", icon: Archive },
};

function stateBadge(state: string) {
  const config = stateConfigs[state] ?? { label: state, variant: "outline" as const, icon: Clock };
  const Icon = config.icon;
  return (
    <Badge variant={config.variant} className="gap-1">
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}

const columnHelper = createColumnHelper<JobRow>();

export function JobMonitor() {
  const { session } = useAuth();
  const token = session?.access_token;

  const [stateFilter, setStateFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const pageSize = 20;

  const listParams: JobListParams = {
    state: stateFilter === "all" ? undefined : stateFilter,
    limit: pageSize,
    offset: page * pageSize
  };

  const statsQuery = useQuery({
    queryKey: ["job-stats"],
    enabled: Boolean(token),
    queryFn: () => fetchJobStats(token ?? ""),
    refetchInterval: 30000 // Auto refresh every 30s
  });

  const listQuery = useQuery({
    queryKey: ["job-list", listParams],
    enabled: Boolean(token),
    queryFn: () => fetchJobList(token ?? "", listParams)
  });

  const stats = statsQuery.data;
  const jobs = listQuery.data?.rows ?? [];
  const totalJobs = listQuery.data?.total ?? 0;
  const totalPages = Math.ceil(totalJobs / pageSize);

  const handleRefresh = () => {
    statsQuery.refetch();
    listQuery.refetch();
  };

  const columns = useMemo(() => [
    columnHelper.accessor("state", {
      header: "状态",
      cell: (info) => stateBadge(info.getValue()),
    }),
    columnHelper.accessor("id", {
      header: "任务 ID",
      cell: (info) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-xs truncate max-w-24 inline-block">
              {info.getValue().slice(0, 8)}…
            </span>
          </TooltipTrigger>
          <TooltipContent className="font-mono text-xs">{info.getValue()}</TooltipContent>
        </Tooltip>
      ),
    }),
    columnHelper.accessor("data", {
      header: "视频 ID",
      cell: (info) => {
        const data = info.getValue();
        const videoId = data?.videoId as string | undefined;
        return videoId ? (
          <span className="font-mono text-xs truncate max-w-24 inline-block">{videoId.slice(0, 8)}…</span>
        ) : "-";
      },
    }),
    columnHelper.accessor("retry_count", {
      header: "重试",
      cell: (info) => {
        const count = info.getValue();
        return count > 0 ? (
          <Badge variant="outline" className="text-xs">{count}</Badge>
        ) : "-";
      },
    }),
    columnHelper.accessor("created_on", {
      header: "创建时间",
      cell: (info) => <span className="text-xs">{formatTime(info.getValue())}</span>,
    }),
    columnHelper.accessor("started_on", {
      header: "开始时间",
      cell: (info) => <span className="text-xs">{formatTime(info.getValue())}</span>,
    }),
    columnHelper.display({
      id: "duration",
      header: "耗时",
      cell: (info) => {
        const row = info.row.original;
        return <span className="text-xs">{formatDuration(row.started_on, row.completed_on)}</span>;
      },
    }),
    columnHelper.accessor("output", {
      header: "结果/错误",
      cell: (info) => {
        const output = info.getValue();
        if (!output) return "-";

        const errorMsg = (output.error || output.message || output.reason) as string | undefined;

        if (errorMsg) {
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-xs text-destructive truncate max-w-32 inline-block cursor-help">
                  {errorMsg}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-md text-xs">{errorMsg}</TooltipContent>
            </Tooltip>
          );
        }
        return <span className="text-xs text-muted-foreground">成功</span>;
      },
    }),
  ], []);

  const table = useReactTable({
    data: jobs,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const statCards = [
    { key: "created", label: "待处理", color: "text-yellow-600" },
    { key: "active", label: "执行中", color: "text-blue-600" },
    { key: "completed", label: "已完成", color: "text-green-600" },
    { key: "failed", label: "失败", color: "text-red-600" },
  ];

  return (
    <div className="space-y-6">
      {/* Stats Overview */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {statCards.map((card) => (
          <Card key={card.key} className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
            <CardHeader className="pb-2">
              <CardDescription>{card.label}</CardDescription>
            </CardHeader>
            <CardContent>
              {statsQuery.isLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <div className={`text-2xl font-bold ${card.color}`}>
                  {stats?.stats[card.key] ?? 0}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Total and Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="text-sm text-muted-foreground">
          总计: <span className="font-medium text-foreground">{stats?.total ?? 0}</span> 个任务
        </div>
        <div className="flex items-center gap-3">
          <Select value={stateFilter} onValueChange={(v) => { setStateFilter(v); setPage(0); }}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="筛选状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="created">待处理</SelectItem>
              <SelectItem value="active">执行中</SelectItem>
              <SelectItem value="completed">已完成</SelectItem>
              <SelectItem value="failed">失败</SelectItem>
              <SelectItem value="retry">重试中</SelectItem>
              <SelectItem value="expired">已过期</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={statsQuery.isFetching || listQuery.isFetching}
          >
            {(statsQuery.isFetching || listQuery.isFetching) ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            刷新
          </Button>
        </div>
      </div>

      {/* Error State */}
      {(statsQuery.error || listQuery.error) && (
        <Alert variant="destructive" className="border-destructive/60 bg-destructive/5">
          <AlertDescription>
            加载失败: {String(statsQuery.error ?? listQuery.error)}
          </AlertDescription>
        </Alert>
      )}

      {/* Job List Table */}
      <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
        <CardHeader>
          <CardTitle>任务列表</CardTitle>
          <CardDescription>
            显示 {jobs.length} / {totalJobs} 个任务
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TooltipProvider>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <TableHead key={header.id}>
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                        </TableHead>
                      ))}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {listQuery.isLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={i}>
                        {columns.map((_, j) => (
                          <TableCell key={j}>
                            <Skeleton className="h-4 w-full" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : table.getRowModel().rows?.length ? (
                    table.getRowModel().rows.map((row) => (
                      <TableRow key={row.id}>
                        {row.getVisibleCells().map((cell) => (
                          <TableCell key={cell.id}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={columns.length} className="py-8 text-center text-muted-foreground">
                        暂无任务
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </TooltipProvider>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <div className="text-sm text-muted-foreground">
                第 {page + 1} / {totalPages} 页
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                >
                  下一页
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
