import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  type PaginationState,
} from "@tanstack/react-table";
import { useAuth } from "../lib/auth";
import { enqueueAnalysis, fetchAdminVideos, type AdminVideoRow, type AdminVideosParams } from "../lib/jobsApi";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Skeleton } from "./ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ChevronDown, ChevronUp, Eye, Loader2, RefreshCw, Sparkles, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

const STATUS_OPTIONS = [
  { value: "all", label: "所有状态" },
  { value: "pending", label: "待处理" },
  { value: "active", label: "活跃" },
  { value: "error", label: "错误" }
];

const ANALYSIS_STATUS_OPTIONS = [
  { value: "all", label: "所有分析状态" },
  { value: "none", label: "无分析" },
  { value: "queued", label: "已排队" },
  { value: "processing", label: "处理中" },
  { value: "completed", label: "已完成" },
  { value: "failed", label: "失败" }
];

const PAGE_SIZE_OPTIONS = [
  { value: "10", label: "每页 10 条" },
  { value: "20", label: "每页 20 条" },
  { value: "50", label: "每页 50 条" },
  { value: "100", label: "每页 100 条" }
];

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function shortId(value: string | null | undefined, length = 8) {
  if (!value) return "-";
  if (value.length <= length + 3) return value;
  return `${value.slice(0, length)}...`;
}

function getStatusBadgeVariant(status: string) {
  if (status === "active") return "secondary";
  if (status === "pending") return "outline";
  if (status === "error") return "destructive";
  return "outline";
}

function getAnalysisBadgeVariant(status: string | null) {
  if (!status) return "outline";
  if (status === "completed") return "secondary";
  if (status === "failed") return "destructive";
  if (status === "queued" || status === "processing") return "default";
  return "outline";
}

function translateStatus(status: string) {
  const statusMap: Record<string, string> = {
    pending: "待处理",
    active: "活跃",
    error: "错误"
  };
  return statusMap[status] ?? status;
}

function translateAnalysisStatus(status: string | null) {
  if (!status) return "无分析";
  const statusMap: Record<string, string> = {
    none: "无分析",
    queued: "已排队",
    processing: "处理中",
    completed: "已完成",
    failed: "失败"
  };
  return statusMap[status] ?? status;
}

function TruncatedText({
  text,
  maxLength = 50,
  className = ""
}: {
  text: string | null | undefined;
  maxLength?: number;
  className?: string;
}) {
  if (!text) return <span className={className}>-</span>;
  if (text.length <= maxLength) return <span className={className}>{text}</span>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`cursor-help ${className}`}>
          {text.slice(0, maxLength)}...
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[400px] whitespace-pre-wrap">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function CopyableId({ id, label }: { id: string | null | undefined; label?: string }) {
  if (!id) return <span className="text-muted-foreground">-</span>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="cursor-pointer font-mono text-xs text-muted-foreground hover:text-foreground"
          onClick={() => navigator.clipboard.writeText(id)}
        >
          {shortId(id)}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {label ? `${label}: ` : ""}{id}
        <br />
        <span className="text-xs opacity-70">点击复制</span>
      </TooltipContent>
    </Tooltip>
  );
}

type DetailDialogData = {
  title: string;
  content: string;
} | null;

const columnHelper = createColumnHelper<AdminVideoRow>();

export function Videos() {
  const { session } = useAuth();
  const token = session?.access_token;
  const queryClient = useQueryClient();

  // Filter form state
  const [formUserId, setFormUserId] = useState("");
  const [formYoutubeVideoId, setFormYoutubeVideoId] = useState("");
  const [formTitle, setFormTitle] = useState("");
  const [formStatus, setFormStatus] = useState("all");
  const [formAnalysisStatus, setFormAnalysisStatus] = useState("all");
  const [showFilters, setShowFilters] = useState(false);

  // Applied filters
  const [filters, setFilters] = useState<AdminVideosParams>({});

  // Pagination
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });

  // UI state
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailDialog, setDetailDialog] = useState<DetailDialogData>(null);

  const videosQuery = useQuery({
    queryKey: ["admin-videos", filters, pagination],
    enabled: Boolean(token),
    queryFn: () =>
      fetchAdminVideos(token ?? "", {
        ...filters,
        limit: pagination.pageSize,
        offset: pagination.pageIndex * pagination.pageSize
      })
  });

  const analyzeMutation = useMutation({
    mutationFn: (row: AdminVideoRow) =>
      enqueueAnalysis(token ?? "", {
        userId: row.user_id,
        videoIds: [row.id]
      }),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["admin-videos"] });
    },
    onError: (err: Error) => {
      setActionError(err.message);
    }
  });

  const rows = videosQuery.data?.rows ?? [];
  // Since we don't have total count in this specific query response (unlike system_users),
  // we estimate pageCount. If current page returned pageSize rows, we assume there is a next page.
  // This "infinite scroll" like pagination logic is kept as is but adapted for table state.
  // Actually, standard pagination usually needs a total count. 
  // Looking at fetchAdminVideos return type in jobApi, let's see if it returns total.
  // It returns { rows: AdminVideoRow[] }. No total.
  // So we can only know if there's a next page if we got full page of results.

  const hasNextPage = rows.length === pagination.pageSize;
  // We can't know the true page count, so we'll set it to pageIndex + 2 if there's a next page, 
  // or pageIndex + 1 if this is the last page.
  const pageCount = hasNextPage ? pagination.pageIndex + 2 : pagination.pageIndex + 1;

  const handleApply = (event: React.FormEvent) => {
    event.preventDefault();
    setFilters({
      userId: formUserId.trim() || undefined,
      youtubeVideoId: formYoutubeVideoId.trim() || undefined,
      title: formTitle.trim() || undefined,
      status: formStatus === "all" ? undefined : formStatus,
      analysisStatus: formAnalysisStatus === "all" ? undefined : formAnalysisStatus
    });
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  };

  const handleReset = () => {
    setFormUserId("");
    setFormYoutubeVideoId("");
    setFormTitle("");
    setFormStatus("all");
    setFormAnalysisStatus("all");
    setFilters({});
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  };

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const columns = useMemo(
    () => [
      columnHelper.accessor("title", {
        header: "视频",
        cell: (info) => {
          const row = info.row.original;
          return (
            <div className="font-medium">
              <div>
                <TruncatedText text={row.title} maxLength={40} />
              </div>
              <div className="text-xs text-muted-foreground">
                YT: {row.youtube_video_id}
              </div>
              <div className="text-xs text-muted-foreground">
                时长: {row.duration ?? "-"}
              </div>
            </div>
          );
        },
      }),
      columnHelper.display({
        id: "ids",
        header: "ID",
        cell: (info) => {
          const row = info.row.original;
          return (
            <div className="space-y-1">
              <div className="text-xs">
                <span className="text-muted-foreground">视频: </span>
                <CopyableId id={row.id} />
              </div>
              <div className="text-xs">
                <span className="text-muted-foreground">用户: </span>
                <CopyableId id={row.user_id} />
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor("status", {
        header: "状态",
        cell: (info) => {
          const row = info.row.original;
          return (
            <div>
              <Badge variant={getStatusBadgeVariant(row.status)} className="capitalize">
                {translateStatus(row.status)}
              </Badge>
              {row.removed_at && (
                <div className="mt-1 text-xs text-muted-foreground">
                  已移除: {formatTime(row.removed_at)}
                </div>
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor("analysis_status", {
        header: "分析",
        cell: (info) => {
          const row = info.row.original;
          return (
            <div>
              <Badge variant={getAnalysisBadgeVariant(row.analysis_status)}>
                {translateAnalysisStatus(row.analysis_status)}
              </Badge>
              <div className="mt-1 text-xs text-muted-foreground">
                共 {row.analysis_count} 次
              </div>
              {row.analysis_model && (
                <div className="text-xs text-muted-foreground">
                  {row.analysis_model}
                </div>
              )}
            </div>
          );
        },
      }),
      columnHelper.display({
        id: "timestamps",
        header: "时间戳",
        cell: (info) => {
          const row = info.row.original;
          return (
            <div className="space-y-1 text-xs text-muted-foreground">
              <div>创建: {formatTime(row.created_at)}</div>
              {row.analysis_created_at && (
                <div>分析: {formatTime(row.analysis_created_at)}</div>
              )}
            </div>
          );
        },
      }),
      columnHelper.display({
        id: "details",
        header: "详情",
        cell: (info) => {
          const row = info.row.original;
          return (
            <div className="flex flex-wrap gap-1">
              {row.analysis_text && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() =>
                    setDetailDialog({
                      title: "分析结果",
                      content: row.analysis_text ?? ""
                    })
                  }
                >
                  <Eye className="mr-1 h-3 w-3" />
                  文本
                </Button>
              )}
              {row.analysis_error && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-destructive"
                  onClick={() =>
                    setDetailDialog({
                      title: "分析错误",
                      content: row.analysis_error ?? ""
                    })
                  }
                >
                  <Eye className="mr-1 h-3 w-3" />
                  错误
                </Button>
              )}
            </div>
          );
        },
      }),
      columnHelper.display({
        id: "actions",
        header: "操作",
        cell: (info) => {
          const row = info.row.original;
          const analysisStatus = row.analysis_status ?? "";
          const isLocked = analysisStatus === "queued" || analysisStatus === "processing";
          const canAnalyze = row.status === "active" && !isLocked;
          const isPending = analyzeMutation.isPending && analyzeMutation.variables?.id === row.id;

          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={!canAnalyze ? 0 : undefined}>
                  <Button
                    size="sm"
                    onClick={() => analyzeMutation.mutate(row)}
                    disabled={!canAnalyze || isPending}
                  >
                    {isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        排队中...
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        {row.analysis_status ? "重新运行" : "分析"}
                      </>
                    )}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {canAnalyze
                  ? "排队分析"
                  : isLocked
                    ? "分析已排队或正在处理中"
                    : "只有活跃的视频才能被分析"}
              </TooltipContent>
            </Tooltip>
          );
        },
      }),
    ],
    [analyzeMutation.isPending, analyzeMutation.variables?.id]
  );

  const table = useReactTable({
    data: rows,
    columns,
    pageCount, // manual page count
    state: {
      pagination,
    },
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  });

  return (
    <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>视频库</CardTitle>
          <CardDescription>
            筛选视频并手动为选定项目排队 Gemini 分析。
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{rows.length} 个视频</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => videosQuery.refetch()}
            disabled={videosQuery.isFetching}
          >
            <RefreshCw className={videosQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Filter Section */}
        <div className="mb-6">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
            className="mb-4"
          >
            {showFilters ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            筛选
            {activeFilterCount > 0 && (
              <Badge variant="secondary" className="ml-2">
                {activeFilterCount}
              </Badge>
            )}
          </Button>

          {showFilters && (
            <form onSubmit={handleApply} className="rounded-lg border border-border/70 bg-muted/20 p-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="filter-user">用户 ID</Label>
                  <Input
                    id="filter-user"
                    placeholder="按用户 UUID 筛选"
                    value={formUserId}
                    onChange={(e) => setFormUserId(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="filter-youtube-video">YouTube 视频 ID</Label>
                  <Input
                    id="filter-youtube-video"
                    placeholder="例如: dQw4w9WgXcQ"
                    value={formYoutubeVideoId}
                    onChange={(e) => setFormYoutubeVideoId(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="filter-title">标题（包含）</Label>
                  <Input
                    id="filter-title"
                    placeholder="按标题搜索"
                    value={formTitle}
                    onChange={(e) => setFormTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="filter-status">状态</Label>
                  <Select value={formStatus} onValueChange={setFormStatus}>
                    <SelectTrigger id="filter-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="filter-analysis-status">分析状态</Label>
                  <Select value={formAnalysisStatus} onValueChange={setFormAnalysisStatus}>
                    <SelectTrigger id="filter-analysis-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ANALYSIS_STATUS_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-2">
                <Button type="submit" size="sm">
                  应用筛选
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleReset}>
                  重置
                </Button>
              </div>
            </form>
          )}
        </div>

        {actionError && (
          <Alert variant="destructive" className="mb-4 border-destructive/60 bg-destructive/5">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}

        {videosQuery.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : videosQuery.error ? (
          <Alert variant="destructive" className="border-destructive/60 bg-destructive/5">
            <AlertDescription>
              加载视频失败: {String(videosQuery.error)}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <TableHead key={header.id} className="text-xs uppercase tracking-wide text-muted-foreground">
                          {header.isPlaceholder
                            ? null
                            : flexRender(
                              header.column.columnDef.header,
                              header.getContext()
                            )}
                        </TableHead>
                      ))}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {table.getRowModel().rows?.length ? (
                    table.getRowModel().rows.map((row) => (
                      <TableRow
                        key={row.id}
                        data-state={row.getIsSelected() && "selected"}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <TableCell key={cell.id} className="align-top">
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext()
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={columns.length} className="py-8 text-center text-muted-foreground">
                        当前筛选条件下未找到视频。
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            {rows.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span>
                    第 {table.getState().pagination.pageIndex + 1} 页 · 显示 {rows.length} 个视频
                  </span>
                  <Select
                    value={`${table.getState().pagination.pageSize}`}
                    onValueChange={(value) => {
                      table.setPageSize(Number(value));
                    }}
                  >
                    <SelectTrigger className="h-8 w-[120px]">
                      <SelectValue placeholder={table.getState().pagination.pageSize} />
                    </SelectTrigger>
                    <SelectContent side="top">
                      {PAGE_SIZE_OPTIONS.map((pageSize) => (
                        <SelectItem key={pageSize.value} value={pageSize.value}>
                          {pageSize.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center space-x-2">
                  <Button
                    variant="outline"
                    className="h-8 w-8 p-0"
                    onClick={() => table.previousPage()}
                    disabled={!table.getCanPreviousPage()}
                  >
                    <span className="sr-only">Go to previous page</span>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    className="h-8 w-8 p-0"
                    onClick={() => table.nextPage()}
                    disabled={!hasNextPage}
                  >
                    <span className="sr-only">Go to next page</span>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Detail Dialog */}
        <Dialog open={!!detailDialog} onOpenChange={() => setDetailDialog(null)}>
          <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
            <DialogHeader>
              <DialogTitle>{detailDialog?.title}</DialogTitle>
              <DialogDescription>完整内容视图</DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-auto">
              <pre className="whitespace-pre-wrap wrap-break-word rounded-lg bg-muted/50 p-4 text-sm">
                {detailDialog?.content}
              </pre>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
