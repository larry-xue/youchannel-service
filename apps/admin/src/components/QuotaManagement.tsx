import { useEffect, useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";
import { useAuth } from "../lib/auth";
import {
  fetchUserQuota,
  addQuotaGrant,
  refundQuota,
  refreshQuotaCache,
  type QuotaGrant,
  type QuotaUsageEvent,
  type AddGrantParams
} from "../lib/jobsApi";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Alert, AlertDescription } from "./ui/alert";
import { Skeleton } from "./ui/skeleton";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "./ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Search, Plus, RefreshCw, Undo2, Loader2 } from "lucide-react";

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatSeconds(seconds: number) {
  if (seconds === 0) return "0 秒";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分钟`);
  if (secs > 0) parts.push(`${secs} 秒`);
  return parts.join(" ");
}

function statusBadge(grant: QuotaGrant) {
  const now = new Date();
  const validFrom = new Date(grant.valid_from);
  const validTo = grant.valid_to ? new Date(grant.valid_to) : null;

  if (grant.status === "revoked") {
    return <Badge variant="destructive">已撤销</Badge>;
  }
  if (validFrom > now) {
    return <Badge variant="outline">未生效</Badge>;
  }
  if (validTo && validTo < now) {
    return <Badge variant="secondary">已过期</Badge>;
  }
  if (grant.video_seconds_remaining <= 0 && grant.chat_seconds_remaining <= 0) {
    return <Badge variant="secondary">已耗尽</Badge>;
  }
  return <Badge variant="default">有效</Badge>;
}

function eventTypeBadge(eventType: string) {
  switch (eventType) {
    case "consume":
      return <Badge variant="destructive">消费</Badge>;
    case "refund":
      return <Badge variant="default">退款</Badge>;
    case "adjust":
      return <Badge variant="secondary">调整</Badge>;
    default:
      return <Badge variant="outline">{eventType}</Badge>;
  }
}

const grantsColumnHelper = createColumnHelper<QuotaGrant>();
const eventsColumnHelper = createColumnHelper<QuotaUsageEvent>();

export function QuotaManagement() {
  const { session } = useAuth();
  const token = session?.access_token;
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as { userId?: string };

  const [searchUserId, setSearchUserId] = useState(search.userId ?? "");
  const [activeUserId, setActiveUserId] = useState<string | null>(search.userId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [addGrantOpen, setAddGrantOpen] = useState(false);
  const [refundDialogOpen, setRefundDialogOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<QuotaUsageEvent | null>(null);
  const [refundReason, setRefundReason] = useState("");

  const [grantForm, setGrantForm] = useState<{
    videoSecondsTotal: string;
    chatSecondsTotal: string;
    maxVideoSeconds: string;
    sourceType: string;
    sourceRef: string;
    validTo: string;
    consumePriority: string;
  }>({
    videoSecondsTotal: "3600",
    chatSecondsTotal: "7200",
    maxVideoSeconds: "1800",
    sourceType: "manual",
    sourceRef: "",
    validTo: "",
    consumePriority: "100"
  });

  // Sync with URL search param changes
  useEffect(() => {
    if (search.userId) {
      setSearchUserId(search.userId);
      setActiveUserId(search.userId);
    }
  }, [search.userId]);

  const quotaQuery = useQuery({
    queryKey: ["user-quota", activeUserId],
    enabled: Boolean(token && activeUserId),
    queryFn: () => fetchUserQuota(token ?? "", activeUserId ?? "")
  });

  const addGrantMutation = useMutation({
    mutationFn: (params: AddGrantParams) => addQuotaGrant(token ?? "", params),
    onSuccess: (data) => {
      if (data.error) {
        setError(data.error);
      } else {
        setAddGrantOpen(false);
        setError(null);
        queryClient.invalidateQueries({ queryKey: ["user-quota", activeUserId] });
      }
    },
    onError: (err: Error) => {
      setError(err.message);
    }
  });

  const refundMutation = useMutation({
    mutationFn: (params: { userId: string; originalEventId: string; reason?: string }) =>
      refundQuota(token ?? "", params),
    onSuccess: (data) => {
      if (data.error) {
        setError(data.error);
      } else {
        setRefundDialogOpen(false);
        setSelectedEvent(null);
        setRefundReason("");
        setError(null);
        queryClient.invalidateQueries({ queryKey: ["user-quota", activeUserId] });
      }
    },
    onError: (err: Error) => {
      setError(err.message);
    }
  });

  const refreshMutation = useMutation({
    mutationFn: (userId: string) => refreshQuotaCache(token ?? "", userId),
    onSuccess: (data) => {
      if (data.error) {
        setError(data.error);
      } else {
        setError(null);
        queryClient.invalidateQueries({ queryKey: ["user-quota", activeUserId] });
      }
    },
    onError: (err: Error) => {
      setError(err.message);
    }
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = searchUserId.trim();
    if (!trimmed) {
      setError("请输入用户 ID");
      return;
    }
    setActiveUserId(trimmed);
  };

  const handleAddGrant = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeUserId) return;

    const params: AddGrantParams = {
      userId: activeUserId,
      videoSecondsTotal: parseInt(grantForm.videoSecondsTotal, 10) || 0,
      chatSecondsTotal: parseInt(grantForm.chatSecondsTotal, 10) || 0,
      maxVideoSeconds: parseInt(grantForm.maxVideoSeconds, 10) || 0,
      sourceType: grantForm.sourceType,
      sourceRef: grantForm.sourceRef || undefined,
      validTo: grantForm.validTo || undefined,
      consumePriority: parseInt(grantForm.consumePriority, 10) || 100
    };

    addGrantMutation.mutate(params);
  };

  const handleRefund = () => {
    if (!activeUserId || !selectedEvent) return;
    refundMutation.mutate({
      userId: activeUserId,
      originalEventId: selectedEvent.id,
      reason: refundReason || undefined
    });
  };

  const handleRefresh = () => {
    if (!activeUserId) return;
    refreshMutation.mutate(activeUserId);
  };

  const quotaData = quotaQuery.data;
  const cache = quotaData?.quotaCache;
  const grants = quotaData?.grants ?? [];
  const events = quotaData?.events ?? [];

  const grantsColumns = useMemo(() => [
    grantsColumnHelper.accessor("status", {
      header: "状态",
      cell: (info) => statusBadge(info.row.original),
    }),
    grantsColumnHelper.accessor("source_type", {
      header: "来源",
      cell: (info) => {
        const grant = info.row.original;
        return (
          <>
            <div className="text-sm">{grant.source_type}</div>
            {grant.source_ref && (
              <div className="text-xs text-muted-foreground truncate max-w-32">
                {grant.source_ref}
              </div>
            )}
          </>
        );
      }
    }),
    grantsColumnHelper.accessor("video_seconds_remaining", {
      header: "视频剩余/总量",
      cell: (info) =>
        `${formatSeconds(info.getValue())} / ${formatSeconds(info.row.original.video_seconds_total)}`,
    }),
    grantsColumnHelper.accessor("chat_seconds_remaining", {
      header: "聊天剩余/总量",
      cell: (info) =>
        `${formatSeconds(info.getValue())} / ${formatSeconds(info.row.original.chat_seconds_total)}`,
    }),
    grantsColumnHelper.accessor("max_video_seconds", {
      header: "最大视频时长",
      cell: (info) => formatSeconds(info.getValue()),
    }),
    grantsColumnHelper.accessor("consume_priority", {
      header: "优先级",
      cell: (info) => info.getValue(),
    }),
    grantsColumnHelper.accessor("valid_from", {
      header: "有效期",
      cell: (info) => {
        const grant = info.row.original;
        return (
          <div className="text-xs">
            {formatTime(grant.valid_from)}
            {grant.valid_to && (
              <>
                <br />至 {formatTime(grant.valid_to)}
              </>
            )}
          </div>
        )
      }
    }),
    grantsColumnHelper.accessor("created_at", {
      header: "创建时间",
      cell: (info) => <div className="text-sm">{formatTime(info.getValue())}</div>,
    }),
  ], []);

  const eventsColumns = useMemo(() => [
    eventsColumnHelper.accessor("event_type", {
      header: "类型",
      cell: (info) => eventTypeBadge(info.getValue()),
    }),
    eventsColumnHelper.accessor("video_seconds_delta", {
      header: "视频秒数变化",
      cell: (info) => {
        const val = info.getValue();
        return (
          <span className={val < 0 ? "text-destructive" : "text-green-600"}>
            {val > 0 ? "+" : ""}{val}
          </span>
        );
      }
    }),
    eventsColumnHelper.accessor("chat_seconds_delta", {
      header: "聊天秒数变化",
      cell: (info) => {
        const val = info.getValue();
        return (
          <span className={val < 0 ? "text-destructive" : "text-green-600"}>
            {val > 0 ? "+" : ""}{val}
          </span>
        );
      }
    }),
    eventsColumnHelper.accessor("reason", {
      header: "原因",
      cell: (info) => {
        const reason = info.getValue();
        return (
          <div className="max-w-48 truncate">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>{reason ?? "-"}</span>
              </TooltipTrigger>
              {reason && (
                <TooltipContent className="max-w-md">{reason}</TooltipContent>
              )}
            </Tooltip>
          </div>
        );
      }
    }),
    eventsColumnHelper.accessor("created_at", {
      header: "时间",
      cell: (info) => <div className="text-sm">{formatTime(info.getValue())}</div>,
    }),
    eventsColumnHelper.display({
      id: "actions",
      header: "操作",
      cell: (info) => {
        const event = info.row.original;
        const isConsume = event.event_type === "consume";
        const hasRefund = events.some(
          (e) =>
            e.event_type === "refund" &&
            e.context &&
            (e.context as Record<string, unknown>).original_event_id === event.id
        );

        if (isConsume && !hasRefund) {
          return (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectedEvent(event);
                setRefundDialogOpen(true);
              }}
            >
              <Undo2 className="h-4 w-4" />
            </Button>
          );
        }
        if (hasRefund) {
          return <Badge variant="outline" className="text-xs">已退款</Badge>;
        }
        return null;
      }
    })
  ], [events]);

  const grantsTable = useReactTable({
    data: grants,
    columns: grantsColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  const eventsTable = useReactTable({
    data: events,
    columns: eventsColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="space-y-6">
      {/* Search Card */}
      <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
        <CardHeader>
          <CardTitle>用户配额管理</CardTitle>
          <CardDescription>
            输入用户 ID 查看和管理其配额信息
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSearch} className="flex gap-3">
            <Input
              placeholder="输入用户 UUID"
              value={searchUserId}
              onChange={(e) => setSearchUserId(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" disabled={quotaQuery.isLoading}>
              {quotaQuery.isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              查询
            </Button>
          </form>
          {error && (
            <Alert variant="destructive" className="mt-4 border-destructive/60 bg-destructive/5">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* After search: show user quota info */}
      {activeUserId && quotaQuery.isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {activeUserId && quotaQuery.error && (
        <Alert variant="destructive" className="border-destructive/60 bg-destructive/5">
          <AlertDescription>
            加载失败: {String(quotaQuery.error)}
          </AlertDescription>
        </Alert>
      )}

      {activeUserId && quotaData && (
        <>
          {/* User Info & Summary */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
              <CardHeader className="pb-2">
                <CardDescription>用户信息</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-sm font-medium truncate">
                  {quotaData.user?.email ?? "无邮箱"}
                </div>
                <div className="text-xs text-muted-foreground truncate mt-1">
                  {activeUserId}
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
              <CardHeader className="pb-2">
                <CardDescription>视频配额</CardDescription>
              </CardHeader>
              <CardContent>
                {cache ? (
                  <>
                    <div className="text-2xl font-bold">
                      {formatSeconds(cache.video_seconds_remaining)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      总计 {formatSeconds(cache.video_seconds_total)}
                    </div>
                  </>
                ) : (
                  <div className="text-muted-foreground">无缓存数据</div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
              <CardHeader className="pb-2">
                <CardDescription>聊天配额</CardDescription>
              </CardHeader>
              <CardContent>
                {cache ? (
                  <>
                    <div className="text-2xl font-bold">
                      {formatSeconds(cache.chat_seconds_remaining)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      总计 {formatSeconds(cache.chat_seconds_total)}
                    </div>
                  </>
                ) : (
                  <div className="text-muted-foreground">无缓存数据</div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
              <CardHeader className="pb-2">
                <CardDescription>最大视频时长</CardDescription>
              </CardHeader>
              <CardContent>
                {cache ? (
                  <div className="text-2xl font-bold">
                    {formatSeconds(cache.max_video_seconds)}
                  </div>
                ) : (
                  <div className="text-muted-foreground">无缓存数据</div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Action Bar */}
          <div className="flex flex-wrap gap-2">
            <Dialog open={addGrantOpen} onOpenChange={setAddGrantOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="h-4 w-4" />
                  添加授权
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>添加配额授权</DialogTitle>
                  <DialogDescription>
                    为用户 {quotaData.user?.email ?? activeUserId} 添加新的配额授权
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleAddGrant} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>视频秒数</Label>
                      <Input
                        type="number"
                        value={grantForm.videoSecondsTotal}
                        onChange={(e) =>
                          setGrantForm({ ...grantForm, videoSecondsTotal: e.target.value })
                        }
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>聊天秒数</Label>
                      <Input
                        type="number"
                        value={grantForm.chatSecondsTotal}
                        onChange={(e) =>
                          setGrantForm({ ...grantForm, chatSecondsTotal: e.target.value })
                        }
                        required
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>最大视频时长</Label>
                      <Input
                        type="number"
                        value={grantForm.maxVideoSeconds}
                        onChange={(e) =>
                          setGrantForm({ ...grantForm, maxVideoSeconds: e.target.value })
                        }
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>消费优先级</Label>
                      <Input
                        type="number"
                        value={grantForm.consumePriority}
                        onChange={(e) =>
                          setGrantForm({ ...grantForm, consumePriority: e.target.value })
                        }
                      />
                      <p className="text-xs text-muted-foreground">数字越小优先级越高</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>来源类型</Label>
                      <Select
                        value={grantForm.sourceType}
                        onValueChange={(v) => setGrantForm({ ...grantForm, sourceType: v })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="manual">手动</SelectItem>
                          <SelectItem value="promo">促销</SelectItem>
                          <SelectItem value="subscription">订阅</SelectItem>
                          <SelectItem value="package">套餐</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>来源引用</Label>
                      <Input
                        placeholder="工单号或备注"
                        value={grantForm.sourceRef}
                        onChange={(e) =>
                          setGrantForm({ ...grantForm, sourceRef: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>过期时间 (可选)</Label>
                    <Input
                      type="datetime-local"
                      value={grantForm.validTo}
                      onChange={(e) =>
                        setGrantForm({ ...grantForm, validTo: e.target.value })
                      }
                    />
                  </div>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="outline" type="button">取消</Button>
                    </DialogClose>
                    <Button type="submit" disabled={addGrantMutation.isPending}>
                      {addGrantMutation.isPending ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          添加中...
                        </>
                      ) : (
                        "添加授权"
                      )}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>

            <Button
              variant="outline"
              onClick={handleRefresh}
              disabled={refreshMutation.isPending}
            >
              {refreshMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              刷新缓存
            </Button>
          </div>

          {/* Grants Table */}
          <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
            <CardHeader>
              <CardTitle>配额授权</CardTitle>
              <CardDescription>当前用户的所有配额授权</CardDescription>
            </CardHeader>
            <CardContent>
              <TooltipProvider>
                <div className="rounded-md border">
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
              </TooltipProvider>
            </CardContent>
          </Card>

          {/* Events Table */}
          <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
            <CardHeader>
              <CardTitle>使用记录</CardTitle>
              <CardDescription>最近 50 条配额使用事件</CardDescription>
            </CardHeader>
            <CardContent>
              <TooltipProvider>
                <div className="rounded-md border">
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
                            暂无使用记录
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </TooltipProvider>
            </CardContent>
          </Card>

          {/* Refund Dialog */}
          <Dialog open={refundDialogOpen} onOpenChange={setRefundDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>发起退款</DialogTitle>
                <DialogDescription>
                  将撤销选中的消费事件，配额将退还到原始授权
                </DialogDescription>
              </DialogHeader>
              {selectedEvent && (
                <div className="space-y-4">
                  <div className="rounded-lg border p-3 text-sm">
                    <div>视频: {selectedEvent.video_seconds_delta} 秒</div>
                    <div>聊天: {selectedEvent.chat_seconds_delta} 秒</div>
                    <div className="text-muted-foreground text-xs mt-1">
                      {formatTime(selectedEvent.created_at)}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>退款原因 (可选)</Label>
                    <Input
                      placeholder="输入退款原因"
                      value={refundReason}
                      onChange={(e) => setRefundReason(e.target.value)}
                    />
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setRefundDialogOpen(false);
                    setSelectedEvent(null);
                    setRefundReason("");
                  }}
                >
                  取消
                </Button>
                <Button
                  onClick={handleRefund}
                  disabled={refundMutation.isPending}
                >
                  {refundMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      退款中...
                    </>
                  ) : (
                    "确认退款"
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
