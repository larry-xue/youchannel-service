import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  type PaginationState,
  type ColumnDef,
} from "@tanstack/react-table";
import { useAuth } from "../lib/auth";
import { fetchSystemUsers, type SystemUserRow, type SystemUsersParams, type YoutubeAccountSummary } from "../lib/jobsApi";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Alert, AlertDescription } from "./ui/alert";
import { Skeleton } from "./ui/skeleton";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
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
import { ChevronDown, ChevronUp, Eye, RefreshCw, Coins, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

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

function formatSeconds(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (!Number.isFinite(value)) return "-";
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function shortId(value: string | null | undefined, length = 8) {
  if (!value) return "-";
  if (value.length <= length + 3) return value;
  return `${value.slice(0, length)}...`;
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

function AccountsCell({ accounts }: { accounts: YoutubeAccountSummary[] }) {
  if (!accounts.length) {
    return <span className="text-sm text-muted-foreground">无关联账户</span>;
  }

  return (
    <div className="space-y-2">
      {accounts.map((account) => (
        <div
          key={account.id}
          className="rounded-lg border border-border/60 bg-muted/40 p-2 text-xs"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-muted-foreground">
              {account.id.slice(0, 8)}...
            </span>
            <Badge variant="outline" className="uppercase">
              {account.provider}
            </Badge>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span>创建: {formatTime(account.created_at)}</span>
            <span>更新: {formatTime(account.updated_at)}</span>
            <span>过期: {formatTime(account.expires_at)}</span>
            <span>类型: {account.token_type ?? "-"}</span>
            <span>访问令牌: {account.has_access_token ? "是" : "否"}</span>
            <span>刷新令牌: {account.has_refresh_token ? "是" : "否"}</span>
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground wrap-break-word">
            范围: {account.scope ?? "-"}
          </div>
        </div>
      ))}
    </div>
  );
}

function MetadataCell({ data, title }: { data: Record<string, unknown> | null; title: string }) {
  const [dialogOpen, setDialogOpen] = useState(false);

  if (!data || Object.keys(data).length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        onClick={() => setDialogOpen(true)}
      >
        <Eye className="mr-1 h-3 w-3" />
        查看
      </Button>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>JSON 元数据</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto">
            <pre className="whitespace-pre-wrap wrap-break-word rounded-lg bg-muted/50 p-4 text-sm">
              {JSON.stringify(data, null, 2)}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

const columnHelper = createColumnHelper<SystemUserRow>();

export function SystemUsers() {
  const { session } = useAuth();
  const token = session?.access_token;

  // Filter form state
  const [formEmail, setFormEmail] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // Applied filters
  const [filters, setFilters] = useState<SystemUsersParams>({});

  // Pagination state
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });

  const usersQuery = useQuery({
    queryKey: ["system-users", filters, pagination],
    enabled: Boolean(token),
    queryFn: () =>
      fetchSystemUsers(token ?? "", {
        ...filters,
        limit: pagination.pageSize,
        offset: pagination.pageIndex * pagination.pageSize
      })
  });

  const rows: SystemUserRow[] = usersQuery.data?.rows ?? [];
  const total = usersQuery.data?.total ?? 0;
  const pageCount = Math.ceil(total / pagination.pageSize);
  const accountCount = rows.reduce((acc, row) => acc + row.youtube_accounts.length, 0);

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const columns = useMemo(
    () => [
      columnHelper.accessor("email", {
        header: "用户信息",
        cell: (info) => {
          const row = info.row.original;
          return (
            <div className="font-medium">
              <div>{row.email || "(无邮箱)"}</div>
              {row.phone && (
                <div className="text-xs text-muted-foreground">
                  电话: {row.phone}
                </div>
              )}
              <div className="mt-1 flex items-center gap-1">
                {row.is_anonymous && (
                  <Badge variant="outline" className="text-xs">
                    匿名
                  </Badge>
                )}
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor("id", {
        header: "用户 ID",
        cell: (info) => <CopyableId id={info.getValue()} label="User ID" />,
      }),
      columnHelper.display({
        id: "role_aud",
        header: "角色 / 受众",
        cell: (info) => {
          const row = info.row.original;
          return (
            <div className="space-y-1 text-xs">
              <div>
                <span className="text-muted-foreground">角色: </span>
                {row.role ?? "-"}
              </div>
              <div>
                <span className="text-muted-foreground">受众: </span>
                {row.aud ?? "-"}
              </div>
            </div>
          );
        },
      }),
      columnHelper.display({
        id: "confirmation",
        header: "确认状态",
        cell: (info) => {
          const row = info.row.original;
          return (
            <div className="space-y-1 text-xs">
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">邮箱: </span>
                {row.email_confirmed_at ? (
                  <Badge variant="secondary" className="text-xs">
                    已确认
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs">
                    未确认
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">电话: </span>
                {row.phone_confirmed_at ? (
                  <Badge variant="secondary" className="text-xs">
                    已确认
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs">
                    -
                  </Badge>
                )}
              </div>
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
              <div>确认: {formatTime(row.confirmed_at)}</div>
              <div>最后登录: {formatTime(row.last_sign_in_at)}</div>
            </div>
          );
        },
      }),
      columnHelper.accessor("quota", {
        header: "配额",
        cell: (info) => {
          const quota = info.getValue();
          if (!quota) return <span className="text-xs text-muted-foreground">无配额</span>;

          const videoTotal = quota.video_seconds_total ?? 0;
          const videoRemaining = quota.video_seconds_remaining ?? 0;
          const videoUsed = Math.max(0, videoTotal - videoRemaining);
          const videoPercent =
            videoTotal > 0 ? Math.min(100, (videoUsed / videoTotal) * 100) : 0;
          const chatTotal = quota.chat_seconds_total ?? 0;
          const chatRemaining = quota.chat_seconds_remaining ?? 0;
          const chatUsed = Math.max(0, chatTotal - chatRemaining);

          return (
            <div className="space-y-1">
              <div className="font-medium text-sm">
                视频: {formatSeconds(videoUsed)} / {formatSeconds(videoTotal)}
              </div>
              <div className="w-full bg-muted rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all ${videoPercent >= 100
                    ? "bg-destructive"
                    : videoPercent >= 80
                      ? "bg-yellow-500"
                      : "bg-primary"
                    }`}
                  style={{ width: `${videoPercent}%` }}
                />
              </div>
              <div className="text-xs text-muted-foreground">
                {formatSeconds(videoRemaining)} 剩余 - 最大{" "}
                {formatSeconds(quota.max_video_seconds)}
              </div>
              <div className="text-xs text-muted-foreground">
                聊天: {formatSeconds(chatUsed)} / {formatSeconds(chatTotal)}
              </div>
            </div>
          );
        },
      }),
      columnHelper.display({
        id: "metadata",
        header: "元数据",
        cell: (info) => {
          const row = info.row.original;
          return (
            <div className="flex flex-col gap-1">
              <MetadataCell data={row.app_metadata} title="应用元数据" />
              <MetadataCell data={row.user_metadata} title="用户元数据" />
            </div>
          );
        },
      }),
      columnHelper.accessor("youtube_accounts", {
        header: "YouTube 账户",
        cell: (info) => <AccountsCell accounts={info.getValue()} />,
      }),
      columnHelper.display({
        id: "actions",
        header: "操作",
        cell: (info) => (
          <Button asChild variant="ghost" size="sm">
            <Link to="/quotas" search={{ userId: info.row.original.id }}>
              <Coins className="h-4 w-4" />
            </Link>
          </Button>
        ),
      }),
    ],
    []
  );

  const table = useReactTable({
    data: rows,
    columns,
    pageCount,
    state: {
      pagination,
    },
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  });

  const handleApply = (event: React.FormEvent) => {
    event.preventDefault();
    setFilters({
      email: formEmail.trim() || undefined
    });
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  };

  const handleReset = () => {
    setFormEmail("");
    setFilters({});
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  };

  return (
    <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>系统用户</CardTitle>
          <CardDescription>所有用户及其关联的 YouTube 账户。</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{total} 个用户</Badge>
          <Badge variant="outline">{accountCount} 个账户（本页）</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => usersQuery.refetch()}
            disabled={usersQuery.isFetching}
          >
            <RefreshCw className={usersQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
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
                  <Label htmlFor="filter-email">邮箱（包含）</Label>
                  <Input
                    id="filter-email"
                    placeholder="按邮箱搜索"
                    value={formEmail}
                    onChange={(e) => setFormEmail(e.target.value)}
                  />
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

        {usersQuery.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : usersQuery.error ? (
          <Alert variant="destructive" className="border-destructive/60 bg-destructive/5">
            <AlertDescription>
              加载用户失败: {String(usersQuery.error)}
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
                      <TableCell
                        colSpan={columns.length}
                        className="h-24 text-center"
                      >
                        未找到结果
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span>
                  第 {table.getState().pagination.pageIndex + 1} 页，共 {table.getPageCount()} 页 · 显示 {rows.length} / {total} 个用户
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
