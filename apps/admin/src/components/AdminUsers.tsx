import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../lib/auth";
import { fetchAdminUsers, addAdminUser, removeAdminUser, type AdminUserRow } from "../lib/jobsApi";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Alert, AlertDescription } from "./ui/alert";
import { Skeleton } from "./ui/skeleton";
import { Switch } from "./ui/switch";
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
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious
} from "./ui/pagination";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Plus, Trash2, Loader2 } from "lucide-react";

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

type ConfirmedFilter = "all" | "confirmed" | "unconfirmed";
type SignInFilter = "all" | "recent" | "never";

const RECENT_WINDOW_MS = 1000 * 60 * 60 * 24 * 30;

const metadataToJson = (metadata: Record<string, unknown> | null) =>
  JSON.stringify(metadata ?? {}, null, 2);

export function AdminUsers() {
  const { session } = useAuth();
  const token = session?.access_token;
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [createNew, setCreateNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [confirmedFilter, setConfirmedFilter] = useState<ConfirmedFilter>("all");
  const [signinFilter, setSigninFilter] = useState<SignInFilter>("all");
  const [page, setPage] = useState(1);

  const adminUsersQuery = useQuery({
    queryKey: ["admin-users"],
    enabled: Boolean(token),
    queryFn: () => fetchAdminUsers(token ?? "")
  });

  const addMutation = useMutation({
    mutationFn: (params: { email: string; password?: string; createIfNotExists?: boolean }) =>
      addAdminUser(token ?? "", params.email, {
        password: params.password,
        createIfNotExists: params.createIfNotExists
      }),
    onSuccess: (data) => {
      if (data.error) {
        setError(data.error);
      } else {
        setEmail("");
        setPassword("");
        setCreateNew(false);
        setError(null);
        queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      }
    },
    onError: (err: Error) => {
      setError(err.message);
    }
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeAdminUser(token ?? "", userId),
    onSuccess: (data) => {
      if (data.error) {
        setError(data.error);
      } else {
        setError(null);
        queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      }
    },
    onError: (err: Error) => {
      setError(err.message);
    }
  });

  const rows: AdminUserRow[] = adminUsersQuery.data?.rows ?? [];

  const filteredRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (normalizedSearch) {
        const haystack = [row.email, row.user_id, row.phone, row.role, row.aud]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(normalizedSearch)) {
          return false;
        }
      }

      const emailConfirmed = Boolean(row.email_confirmed_at ?? row.confirmed_at);

      if (confirmedFilter === "confirmed" && !emailConfirmed) {
        return false;
      }
      if (confirmedFilter === "unconfirmed" && emailConfirmed) {
        return false;
      }

      if (signinFilter === "recent") {
        const lastSignIn = row.last_sign_in_at ? new Date(row.last_sign_in_at) : null;
        if (!lastSignIn || Date.now() - lastSignIn.getTime() > RECENT_WINDOW_MS) {
          return false;
        }
      }

      if (signinFilter === "never" && row.last_sign_in_at) {
        return false;
      }

      return true;
    });
  }, [rows, search, confirmedFilter, signinFilter]);

  const rowsPerPage = 10;
  const filteredCount = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(filteredCount / rowsPerPage));
  const currentRows = filteredRows.slice((page - 1) * rowsPerPage, page * rowsPerPage);
  const hasPrevPage = page > 1;
  const hasNextPage = page < totalPages;
  const filtersActive = Boolean(search.trim() || confirmedFilter !== "all" || signinFilter !== "all");
  const startIndex = filteredCount ? (page - 1) * rowsPerPage + 1 : 0;
  const endIndex = filteredCount ? Math.min(filteredCount, page * rowsPerPage) : 0;
  const columnCount = 10;

  useEffect(() => {
    setPage(1);
  }, [search, confirmedFilter, signinFilter]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const resetFilters = () => {
    if (!filtersActive) return;
    setSearch("");
    setConfirmedFilter("all");
    setSigninFilter("all");
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError("邮箱是必填项");
      return;
    }
    if (createNew && !password.trim()) {
      setError("创建新用户时密码是必填项");
      return;
    }
    addMutation.mutate({
      email: email.trim(),
      password: createNew ? password : undefined,
      createIfNotExists: createNew
    });
  };

  const handleRemove = (userId: string) => {
    setUserToDelete(userId);
    setDeleteDialogOpen(true);
  };

  const confirmRemove = () => {
    if (userToDelete) {
      removeMutation.mutate(userToDelete);
      setDeleteDialogOpen(false);
      setUserToDelete(null);
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
        <CardHeader>
          <CardTitle>添加管理员用户</CardTitle>
          <CardDescription>
            通过邮箱地址添加新的管理员。您可以添加现有用户或创建新用户。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">邮箱</Label>
              <Input
                id="email"
                type="email"
                placeholder="admin@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={addMutation.isPending}
                required
              />
            </div>
            <div className="rounded-lg border border-dashed border-border/70 bg-muted/40 p-3">
              <div className="flex items-start gap-3">
                <Switch
                  id="createNew"
                  checked={createNew}
                  onCheckedChange={(checked) => {
                    setCreateNew(checked);
                    if (!checked) {
                      setPassword("");
                    }
                  }}
                  disabled={addMutation.isPending}
                />
                <div>
                  <Label htmlFor="createNew" className="text-sm font-medium">
                    如果用户不存在则创建新用户
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    启用此选项以创建新账户并设置初始密码。
                  </p>
                </div>
              </div>
            </div>
            {createNew && (
              <div className="space-y-2">
                <Label htmlFor="password">密码</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="设置临时密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={addMutation.isPending}
                  required={createNew}
                />
                <p className="text-xs text-muted-foreground">
                  最少 6 个字符。请提醒用户在首次登录后修改密码。
                </p>
              </div>
            )}
            <Button type="submit" className="w-full" disabled={addMutation.isPending}>
              {addMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {createNew ? "创建中..." : "添加中..."}
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" />
                  {createNew ? "创建并添加" : "添加管理员"}
                </>
              )}
            </Button>
            {error && (
              <Alert variant="destructive" className="border-destructive/60 bg-destructive/5">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </form>
        </CardContent>
      </Card>

      <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>管理员用户</CardTitle>
            <CardDescription>
              所有拥有管理员访问权限的用户列表。
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{rows.length} 个管理员</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {adminUsersQuery.isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : adminUsersQuery.error ? (
            <Alert variant="destructive" className="border-destructive/60 bg-destructive/5">
              <AlertDescription>
                加载管理员用户失败: {String(adminUsersQuery.error)}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                <div className="space-y-1">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    搜索
                  </Label>
                  <Input
                    placeholder="按邮箱、ID、电话或角色筛选"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    确认状态
                  </Label>
                  <Select
                    value={confirmedFilter}
                    onValueChange={(value) => setConfirmedFilter(value as ConfirmedFilter)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="所有状态" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部</SelectItem>
                      <SelectItem value="confirmed">邮箱已确认</SelectItem>
                      <SelectItem value="unconfirmed">邮箱未确认</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    最后登录
                  </Label>
                  <Select
                    value={signinFilter}
                    onValueChange={(value) => setSigninFilter(value as SignInFilter)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="任意时间" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">任意时间</SelectItem>
                      <SelectItem value="recent">最近 30 天</SelectItem>
                      <SelectItem value="never">从未登录</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={resetFilters}
                    disabled={!filtersActive}
                  >
                    重置筛选
                  </Button>
                </div>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">显示 {filteredCount} 条</Badge>
                {filtersActive && <Badge variant="secondary">筛选已激活</Badge>}
              </div>
              <TooltipProvider>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        邮箱
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        用户 ID
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        管理员自
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        创建时间
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        最后登录
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        确认状态
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        电话
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        身份
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        元数据
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        操作
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentRows.length ? (
                      currentRows.map((row) => {
                        const isCurrentUser = row.user_id === session?.user.id;
                        const emailConfirmed = Boolean(row.email_confirmed_at ?? row.confirmed_at);
                        const phoneConfirmed = Boolean(row.phone_confirmed_at);
                        const identitySummary = row.identities
                          .map((identity) => identity.provider ?? "identity")
                          .join(", ");

                        return (
                          <TableRow key={row.user_id}>
                            <TableCell className="space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{row.email || "(无邮箱)"}</span>
                                <Badge variant="outline" className="text-[11px]">
                                  {row.role ?? row.aud ?? "user"}
                                </Badge>
                              </div>
                              {row.aud && (
                                <div className="text-[11px] text-muted-foreground">
                                  受众: {row.aud}
                                </div>
                              )}
                            </TableCell>
                            <TableCell>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="font-mono text-xs text-muted-foreground">
                                    {row.user_id.slice(0, 8)}...
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="text-xs">{row.user_id}</TooltipContent>
                              </Tooltip>
                            </TableCell>
                            <TableCell className="text-sm">{formatTime(row.created_at)}</TableCell>
                            <TableCell className="text-sm">{formatTime(row.user_created_at)}</TableCell>
                            <TableCell className="text-sm">{formatTime(row.last_sign_in_at)}</TableCell>
                            <TableCell>
                              <div className="flex flex-col gap-1">
                                <Badge
                                  variant={emailConfirmed ? "secondary" : "outline"}
                                  className="text-[11px]"
                                >
                                  邮箱 {emailConfirmed ? "已确认" : "待确认"}
                                </Badge>
                                {row.phone && (
                                  <Badge
                                    variant={phoneConfirmed ? "secondary" : "outline"}
                                    className="text-[11px]"
                                  >
                                    电话 {phoneConfirmed ? "已确认" : "待确认"}
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-sm">{row.phone ?? "-"}</TableCell>
                            <TableCell>
                              {row.identities.length ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge variant="outline" className="cursor-pointer text-[11px]">
                                      {row.identities.length} 个身份
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent className="text-xs leading-relaxed">
                                    {identitySummary}
                                  </TooltipContent>
                                </Tooltip>
                              ) : (
                                <span className="text-xs text-muted-foreground">无</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <Button variant="ghost" size="sm">
                                    详情
                                  </Button>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>
                                      {row.email ?? row.user_id} 的元数据
                                    </DialogTitle>
                                    <DialogDescription>
                                      完整的 Supabase 用户数据和关联身份信息。
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="space-y-4 text-xs">
                                    <div>
                                      <p className="text-[11px] font-semibold text-muted-foreground">
                                        应用元数据
                                      </p>
                                      <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-border/70 bg-muted/40 p-3 font-mono text-[11px] text-muted-foreground">
{metadataToJson(row.app_metadata)}
                                      </pre>
                                    </div>
                                    <div>
                                      <p className="text-[11px] font-semibold text-muted-foreground">
                                        用户元数据
                                      </p>
                                      <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-border/70 bg-muted/40 p-3 font-mono text-[11px] text-muted-foreground">
{metadataToJson(row.user_metadata)}
                                      </pre>
                                    </div>
                                    <div>
                                      <p className="text-[11px] font-semibold text-muted-foreground">
                                        身份信息
                                      </p>
                                      {row.identities.length ? (
                                        <div className="space-y-2 pt-2">
                                          {row.identities.map((identity) => (
                                            <div
                                              key={identity.id}
                                              className="rounded-md border border-border/70 bg-muted/40 p-2 text-[11px]"
                                            >
                                              <p className="font-semibold">
                                                {identity.provider ?? "identity"}
                                              </p>
                                              <pre className="max-h-32 overflow-auto font-mono text-[11px] text-muted-foreground">
{metadataToJson(identity.identity_data)}
                                              </pre>
                                            </div>
                                          ))}
                                        </div>
                                      ) : (
                                        <p className="text-xs text-muted-foreground pt-2">
                                          无关联身份信息。
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                  <DialogFooter>
                                    <DialogClose asChild>
                                      <Button variant="outline" size="sm">
                                        关闭
                                      </Button>
                                    </DialogClose>
                                  </DialogFooter>
                                </DialogContent>
                              </Dialog>
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRemove(row.user_id)}
                                disabled={removeMutation.isPending || isCurrentUser}
                                aria-label={
                                  isCurrentUser
                                    ? "无法移除自己的访问权限"
                                    : "移除管理员用户"
                                }
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    ) : (
                      <TableRow>
                        <TableCell
                          colSpan={columnCount}
                          className="py-8 text-center text-muted-foreground"
                        >
                          未找到管理员用户
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TooltipProvider>
              {filteredCount > rowsPerPage && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>
                    显示第 {startIndex}-{endIndex} 条，共 {filteredCount} 条
                  </span>
                  <Pagination>
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          href="#"
                          onClick={(event) => {
                            event.preventDefault();
                            setPage((prev) => Math.max(1, prev - 1));
                          }}
                          className={hasPrevPage ? "cursor-pointer" : "pointer-events-none opacity-50"}
                        />
                      </PaginationItem>
                      <PaginationItem>
                        <PaginationNext
                          href="#"
                          onClick={(event) => {
                            event.preventDefault();
                            setPage((prev) => Math.min(totalPages, prev + 1));
                          }}
                          className={hasNextPage ? "cursor-pointer" : "pointer-events-none opacity-50"}
                        />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移除管理员用户</DialogTitle>
            <DialogDescription>
              您确定要移除此管理员用户吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmRemove} disabled={removeMutation.isPending}>
              {removeMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  移除中...
                </>
              ) : (
                "移除"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
