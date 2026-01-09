import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  flexRender,
  createColumnHelper,
  type PaginationState,
} from "@tanstack/react-table";
import { useAuth } from "../lib/auth";
import {
  addQuotaGrant,
  fetchQuotaInfo,
  refundQuota,
  type QuotaUsageEvent,
  type QuotaGrant,
  type QuotaInfo
} from "../lib/jobsApi";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  CreditCard,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  User,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2
} from "lucide-react";

function formatSeconds(seconds: number) {
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (remainingSeconds === 0) return `${minutes}分钟`;
  return `${minutes}分${remainingSeconds}秒`;
}

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

const eventTypeBadge = (type: string) => {
  switch (type) {
    case "admin_grant":
      return <Badge variant="secondary">管理员授权</Badge>;
    case "analysis_cost":
      return <Badge variant="outline">分析消耗</Badge>;
    case "refund":
      return <Badge variant="default" className="bg-green-600 hover:bg-green-700">退款/返还</Badge>;
    default:
      return <Badge variant="outline">{type}</Badge>;
  }
};

const statusBadge = (status: string) => {
  switch (status) {
    case "completed":
      return (
        <Badge variant="outline" className="border-green-500 text-green-500">
          <CheckCircle2 className="mr-1 h-3 w-3" />
          成功
        </Badge>
      );
    case "refunded":
      return (
        <Badge variant="secondary" className="text-muted-foreground">
          <RotateCcw className="mr-1 h-3 w-3" />
          已退款
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          <AlertCircle className="mr-1 h-3 w-3" />
          失败
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
};

const grantsColumnHelper = createColumnHelper<QuotaGrant>();
const eventsColumnHelper = createColumnHelper<QuotaUsageEvent>();

export function QuotaManagement() {
  const { session } = useAuth();
  const token = session?.access_token;
  const queryClient = useQueryClient();

  // Dialog State
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isRefundDialogOpen, setIsRefundDialogOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<QuotaUsageEvent | null>(null);

  // Form State
  const [targetUserId, setTargetUserId] = useState("");
  const [grantAmount, setGrantAmount] = useState("30"); // Default 30 mins
  const [grantPeriod, setGrantPeriod] = useState("monthly");
  const [refundReason, setRefundReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Pagination State for Grants Table
  const [grantsPagination, setGrantsPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });

  // Pagination State for Events Table
  const [eventsPagination, setEventsPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });

  const quotaQuery = useQuery({
    queryKey: ["admin-quota"],
    enabled: Boolean(token),
    queryFn: () => fetchQuotaInfo(token ?? "")
  });

  const addGrantMutation = useMutation({
    mutationFn: () =>
      addQuotaGrant(token ?? "", {
        userId: targetUserId.trim(),
        videoSecondsTotal: Number.parseInt(grantAmount) * 60, // minutes to seconds
        chatSecondsTotal: 0, // Simplified for this UI
        maxVideoSeconds: 3600, // Default max video length
        sourceType: "admin_grant",
      }),
    onSuccess: (data) => {
      if (data.error) {
        setFormError(data.error);
      } else {
        setIsAddDialogOpen(false);
        setTargetUserId("");
        setGrantAmount("30");
        setFormError(null);
        queryClient.invalidateQueries({ queryKey: ["admin-quota"] });
      }
    },
    onError: (err: Error) => {
      setFormError(err.message);
    }
  });

  const refundMutation = useMutation({
    mutationFn: () => {
      if (!selectedEvent) throw new Error("No event selected");
      return refundQuota(token ?? "", {
        userId: selectedEvent.user_id,
        originalEventId: selectedEvent.id,
        reason: refundReason
      });
    },
    onSuccess: (data) => {
      if (data.error) {
        setFormError(data.error);
      } else {
        setIsRefundDialogOpen(false);
        setSelectedEvent(null);
        setRefundReason("");
        setFormError(null);
        queryClient.invalidateQueries({ queryKey: ["admin-quota"] });
      }
    },
    onError: (err: Error) => {
      setFormError(err.message);
    }
  });

  const handleOpenRefund = (event: QuotaUsageEvent) => {
    setSelectedEvent(event);
    setRefundReason("");
    setFormError(null);
    setIsRefundDialogOpen(true);
  };

  const grants = quotaQuery.data?.grants ?? [];
  const events = quotaQuery.data?.events ?? [];

  const grantsColumns = useMemo(() => [
    grantsColumnHelper.accessor("user_id", {
      header: "用户",
      cell: (info) => {
        const row = info.row.original;
        return (
          <div className="flex flex-col">
            <span className="font-medium">{row.user_email || "无邮箱"}</span>
            <span className="font-mono text-xs text-muted-foreground mr-1">
              {shortId(row.user_id)}
            </span>
            {row.user_role && (
              <Badge variant="outline" className="w-fit text-[10px] mt-1">
                {row.user_role}
              </Badge>
            )}
          </div>
        )
      }
    }),
    grantsColumnHelper.display({
      id: "period",
      header: "类型/状态",
      cell: (info) => {
        const row = info.row.original;
        const isActive = row.valid_to ? new Date(row.valid_to) > new Date() : true;
        return (
          <div className="flex flex-col gap-1">
            <Badge variant="outline" className="w-fit">
              {/* Infer period from validity or metadata if available, currently simplified */}
              配额授权
            </Badge>
            <Badge
              variant={isActive ? "secondary" : "destructive"}
              className="w-fit text-[10px]"
            >
              {isActive ? "生效中" : "已过期"}
            </Badge>
          </div>
        );
      }
    }),
    grantsColumnHelper.accessor("video_seconds_total", {
      header: "总额度",
      cell: (info) => (
        <span className="font-medium text-primary">
          {formatSeconds(info.getValue())}
        </span>
      ),
    }),
    grantsColumnHelper.display({
      id: "used_seconds",
      header: "已使用",
      cell: (info) => {
        const row = info.row.original;
        const used = row.video_seconds_total - row.video_seconds_remaining;
        const percent = row.video_seconds_total > 0
          ? Math.min(100, Math.round((used / row.video_seconds_total) * 100))
          : 0;

        return (
          <div className="w-[100px]">
            <div className="mb-1 text-xs">
              {formatSeconds(used)}
              <span className="ml-1 text-muted-foreground">({percent}%)</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        );
      }
    }),
    grantsColumnHelper.accessor("valid_to", {
      header: "有效期至",
      cell: (info) => (
        <div className="text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            结束: {formatTime(info.getValue())}
          </div>
          <div className="mt-0.5">
            更新: {formatTime(info.row.original.updated_at)}
          </div>
        </div>
      ),
    }),
    grantsColumnHelper.display({
      id: "actions",
      header: "操作",
      cell: () => (
        <Button variant="ghost" size="sm" disabled>
          编辑
        </Button>
      )
    })
  ], []);

  const eventsColumns = useMemo(() => [
    // Assuming 'status' is not on QuotaUsageEvent yet based on jobsApi types, 
    // but 'event_type' matches. I'll remove status column or use event_type.
    // Wait, QuotaUsageEvent in jobsApi.ts (line 214) doesn't have 'status'.
    // I'll skip status column for now or infer it.
    // Also QuotaUsageEvent has quota_before/after which I added.
    eventsColumnHelper.accessor("user_id", {
      header: "用户",
      cell: (info) => {
        const row = info.row.original;
        return (
          <div className="flex flex-col">
            <span className="font-medium text-xs">{row.user_email || "未知"}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {shortId(row.user_id)}
            </span>
          </div>
        );
      }
    }),
    eventsColumnHelper.accessor("event_type", {
      header: "事件类型",
      cell: (info) => eventTypeBadge(info.getValue()),
    }),
    eventsColumnHelper.accessor("video_seconds_delta", {
      header: "额度变动",
      cell: (info) => {
        const val = info.getValue();
        return (
          <span
            className={`font-mono font-medium ${val > 0 ? "text-green-600" : "text-destructive"
              }`}
          >
            {val > 0 ? "+" : ""}
            {formatSeconds(val)}
          </span>
        );
      }
    }),
    eventsColumnHelper.display({ // Combined quota info
      id: "quota_snapshot",
      header: "配额快照",
      cell: (info) => {
        const row = info.row.original;
        if (row.quota_before === null || row.quota_before === undefined || row.quota_after === null || row.quota_after === undefined) return "-";
        return (
          <div className="flex flex-col text-xs text-muted-foreground">
            <span>前: {formatSeconds(row.quota_before)}</span>
            <span className="font-medium text-foreground">
              后: {formatSeconds(row.quota_after)}
            </span>
          </div>
        );
      }
    }),
    eventsColumnHelper.accessor("created_at", {
      header: "时间",
      cell: (info) => <span className="text-xs text-muted-foreground">{formatTime(info.getValue())}</span>
    }),
    eventsColumnHelper.display({
      id: "actions",
      header: "操作",
      cell: (info) => {
        const row = info.row.original;
        // Only allow refund if it was a cost (negative delta) and not already refunded (?)
        // We don't have 'status' field to check if refunded.
        if (row.event_type !== "analysis_cost" || row.video_seconds_delta >= 0) return null;
        return (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => handleOpenRefund(row)}
          >
            退款
          </Button>
        );
      }
    })
  ], [handleOpenRefund]);

  const grantsTable = useReactTable({
    data: grants,
    columns: grantsColumns,
    state: {
      pagination: grantsPagination,
    },
    onPaginationChange: setGrantsPagination,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const eventsTable = useReactTable({
    data: events, // Currently limited to 50 from backend but table handles what it gets
    columns: eventsColumns,
    state: {
      pagination: eventsPagination
    },
    onPaginationChange: setEventsPagination,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const PAGE_SIZE_OPTIONS = [
    { value: "10", label: "每页 10 条" },
    { value: "20", label: "每页 20 条" },
    { value: "50", label: "每页 50 条" },
  ];

  const renderPagination = (table: any, dataLength: number, label: string) => (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span>
          第 {table.getState().pagination.pageIndex + 1} 页，共 {table.getPageCount()} 页 · 显示 {dataLength} 条{label}
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
          onClick={() => table.setPageIndex(0)}
          disabled={!table.getCanPreviousPage()}
        >
          <span className="sr-only">Go to first page</span>
          <ChevronsLeft className="h-4 w-4" />
        </Button>
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
          disabled={!table.getCanNextPage()}
        >
          <span className="sr-only">Go to next page</span>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          className="h-8 w-8 p-0"
          onClick={() => table.setPageIndex(table.getPageCount() - 1)}
          disabled={!table.getCanNextPage()}
        >
          <span className="sr-only">Go to last page</span>
          <ChevronsRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">配额管理</h2>
          <p className="text-muted-foreground">
            管理系统用户的 API 调用配额和计费事件。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["admin-quota"] })}
            disabled={quotaQuery.isFetching}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${quotaQuery.isFetching ? "animate-spin" : ""}`}
            />
            刷新数据
          </Button>
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-2 h-4 w-4" />
                授予配额
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>授予新配额</DialogTitle>
                <DialogDescription>
                  为指定用户添加额外的 API 使用时长。
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="userId">用户 ID (UUID)</Label>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="userId"
                      placeholder="e.g. 123e4567-e89b-12d3-a456-426614174000"
                      className="pl-9"
                      value={targetUserId}
                      onChange={(e) => setTargetUserId(e.target.value)}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="amount">额度 (分钟)</Label>
                    <Select value={grantAmount} onValueChange={setGrantAmount}>
                      <SelectTrigger id="amount">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="10">10 分钟</SelectItem>
                        <SelectItem value="30">30 分钟</SelectItem>
                        <SelectItem value="60">1 小时</SelectItem>
                        <SelectItem value="120">2 小时</SelectItem>
                        <SelectItem value="300">5 小时</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="period">类型</Label>
                    <Select value={grantPeriod} onValueChange={setGrantPeriod}>
                      <SelectTrigger id="period">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="monthly">月度 (自动重置)</SelectItem>
                        <SelectItem value="onetime">一次性 (叠加)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {formError && (
                  <Alert variant="destructive" className="border-destructive/60 bg-destructive/5">
                    <AlertDescription>{formError}</AlertDescription>
                  </Alert>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                  取消
                </Button>
                <Button onClick={() => addGrantMutation.mutate()} disabled={addGrantMutation.isPending}>
                  {addGrantMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  确认授权
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">总授权额度</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {quotaQuery.isLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-2xl font-bold">
                {formatSeconds(
                  grants.reduce((acc, g) => acc + g.video_seconds_total, 0)
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">所有用户的总配额池</p>
          </CardContent>
        </Card>
        <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">已使用额度</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {quotaQuery.isLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-2xl font-bold">
                {formatSeconds(
                  grants.reduce((acc, g) => acc + (g.video_seconds_total - g.video_seconds_remaining), 0)
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">当前周期内消耗总量</p>
          </CardContent>
        </Card>
        <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">活跃用户</CardTitle>
            <User className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {quotaQuery.isLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-2xl font-bold">
                {new Set(grants.map((g) => g.user_id)).size}
              </div>
            )}
            <p className="text-xs text-muted-foreground">拥有配额的用户数</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="grants" className="space-y-4">
        <TabsList>
          <TabsTrigger value="grants">配额授权</TabsTrigger>
          <TabsTrigger value="events">使用记录</TabsTrigger>
        </TabsList>
        <TabsContent value="grants" className="space-y-4">
          <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
            <CardHeader>
              <CardTitle>授权列表</CardTitle>
              <CardDescription>
                所有用户的配额授权详情和使用情况。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {quotaQuery.isLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : quotaQuery.error ? (
                <Alert variant="destructive">
                  <AlertDescription>无法加载配额数据</AlertDescription>
                </Alert>
              ) : (
                <>
                  <div className="overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        {grantsTable.getHeaderGroups().map((headerGroup) => (
                          <TableRow key={headerGroup.id}>
                            {headerGroup.headers.map((header) => (
                              <TableHead key={header.id}>
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
                        {grantsTable.getRowModel().rows?.length ? (
                          grantsTable.getRowModel().rows.map((row) => (
                            <TableRow
                              key={row.id}
                              data-state={row.getIsSelected() && "selected"}
                            >
                              {row.getVisibleCells().map((cell) => (
                                <TableCell key={cell.id}>
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
                            <TableCell colSpan={grantsColumns.length} className="py-8 text-center text-muted-foreground">
                              暂无配额授权
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                  {grants.length > 0 && renderPagination(grantsTable, grants.length, "记录")}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="events" className="space-y-4">
          <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
            <CardHeader>
              <CardTitle>最近事件</CardTitle>
              <CardDescription>
                最近 50 条配额使用事件和变更记录。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {quotaQuery.isLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        {eventsTable.getHeaderGroups().map((headerGroup) => (
                          <TableRow key={headerGroup.id}>
                            {headerGroup.headers.map((header) => (
                              <TableHead key={header.id}>
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
                        {eventsTable.getRowModel().rows?.length ? (
                          eventsTable.getRowModel().rows.map((row) => (
                            <TableRow
                              key={row.id}
                              data-state={row.getIsSelected() && "selected"}
                            >
                              {row.getVisibleCells().map((cell) => (
                                <TableCell key={cell.id}>
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
                            <TableCell colSpan={eventsColumns.length} className="py-8 text-center text-muted-foreground">
                              暂无事件记录
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                  {events.length > 0 && renderPagination(eventsTable, events.length, "事件")}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={isRefundDialogOpen} onOpenChange={setIsRefundDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>退款/返还配额</DialogTitle>
            <DialogDescription>
              将消耗的配额返还给用户。此操作将增加用户的剩余配额。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/20 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">用户:</span>
                <span className="font-medium">{selectedEvent?.user_email}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">扣除额度:</span>
                <span className="font-medium text-destructive">
                  {formatSeconds(Math.abs(selectedEvent?.video_seconds_delta ?? 0))}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">事件 ID:</span>
                <span className="font-mono text-xs">{selectedEvent?.id}</span>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="reason">退款原因</Label>
              <Input
                id="reason"
                placeholder="例如: 分析任务失败，系统错误"
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
              />
            </div>
            {formError && (
              <Alert variant="destructive" className="border-destructive/60 bg-destructive/5">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRefundDialogOpen(false)}>
              取消
            </Button>
            <Button
              variant="default"
              onClick={() => refundMutation.mutate()}
              disabled={refundMutation.isPending || !refundReason.trim()}
            >
              {refundMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" />
              )}
              确认退款
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
