import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  PaginationEllipsis,
} from "./ui/pagination";
import { ChevronDown, ChevronUp, Eye, RefreshCw } from "lucide-react";

const PAGE_SIZE_OPTIONS = [
  { value: "10", label: "10 / page" },
  { value: "20", label: "20 / page" },
  { value: "50", label: "50 / page" },
  { value: "100", label: "100 / page" }
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
        <span className="text-xs opacity-70">Click to copy</span>
      </TooltipContent>
    </Tooltip>
  );
}

function AccountsCell({ accounts }: { accounts: YoutubeAccountSummary[] }) {
  if (!accounts.length) {
    return <span className="text-sm text-muted-foreground">No linked accounts</span>;
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
            <span>Created: {formatTime(account.created_at)}</span>
            <span>Updated: {formatTime(account.updated_at)}</span>
            <span>Expires: {formatTime(account.expires_at)}</span>
            <span>Type: {account.token_type ?? "-"}</span>
            <span>Access: {account.has_access_token ? "yes" : "no"}</span>
            <span>Refresh: {account.has_refresh_token ? "yes" : "no"}</span>
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground wrap-break-word">
            Scope: {account.scope ?? "-"}
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
        View
      </Button>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>JSON metadata</DialogDescription>
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

export function SystemUsers() {
  const { session } = useAuth();
  const token = session?.access_token;

  // Filter form state
  const [formEmail, setFormEmail] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // Applied filters
  const [filters, setFilters] = useState<SystemUsersParams>({});

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const usersQuery = useQuery({
    queryKey: ["system-users", filters, page, pageSize],
    enabled: Boolean(token),
    queryFn: () =>
      fetchSystemUsers(token ?? "", {
        ...filters,
        limit: pageSize,
        offset: (page - 1) * pageSize
      })
  });

  const rows: SystemUserRow[] = usersQuery.data?.rows ?? [];
  const total = usersQuery.data?.total ?? 0;
  const accountCount = rows.reduce((acc, row) => acc + row.youtube_accounts.length, 0);
  const totalPages = Math.ceil(total / pageSize) || 1;

  const handleApply = (event: React.FormEvent) => {
    event.preventDefault();
    setFilters({
      email: formEmail.trim() || undefined
    });
    setPage(1);
  };

  const handleReset = () => {
    setFormEmail("");
    setFilters({});
    setPage(1);
  };

  const handlePageSizeChange = (value: string) => {
    setPageSize(Number(value));
    setPage(1);
  };

  // Generate page numbers for pagination
  const getPageNumbers = () => {
    const pages: (number | "ellipsis")[] = [];
    const maxVisiblePages = 5;

    if (totalPages <= maxVisiblePages) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      pages.push(1);
      if (page > 3) {
        pages.push("ellipsis");
      }
      const start = Math.max(2, page - 1);
      const end = Math.min(totalPages - 1, page + 1);
      for (let i = start; i <= end; i++) {
        pages.push(i);
      }
      if (page < totalPages - 2) {
        pages.push("ellipsis");
      }
      if (totalPages > 1) {
        pages.push(totalPages);
      }
    }

    return pages;
  };

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>System Users</CardTitle>
          <CardDescription>All users and their linked YouTube accounts.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{total} users</Badge>
          <Badge variant="outline">{accountCount} accounts (this page)</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => usersQuery.refetch()}
            disabled={usersQuery.isFetching}
          >
            <RefreshCw className={usersQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Refresh
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
            Filters
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
                  <Label htmlFor="filter-email">Email (contains)</Label>
                  <Input
                    id="filter-email"
                    placeholder="Search by email"
                    value={formEmail}
                    onChange={(e) => setFormEmail(e.target.value)}
                  />
                </div>
              </div>
              <div className="mt-4 flex items-center gap-2">
                <Button type="submit" size="sm">
                  Apply Filters
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleReset}>
                  Reset
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
              Failed to load users: {String(usersQuery.error)}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[180px] text-xs uppercase tracking-wide text-muted-foreground">
                      User Info
                    </TableHead>
                    <TableHead className="min-w-[120px] text-xs uppercase tracking-wide text-muted-foreground">
                      User ID
                    </TableHead>
                    <TableHead className="min-w-[100px] text-xs uppercase tracking-wide text-muted-foreground">
                      Role / Aud
                    </TableHead>
                    <TableHead className="min-w-[140px] text-xs uppercase tracking-wide text-muted-foreground">
                      Confirmation
                    </TableHead>
                    <TableHead className="min-w-[180px] text-xs uppercase tracking-wide text-muted-foreground">
                      Timestamps
                    </TableHead>
                    <TableHead className="min-w-[100px] text-xs uppercase tracking-wide text-muted-foreground">
                      Quota
                    </TableHead>
                    <TableHead className="min-w-[100px] text-xs uppercase tracking-wide text-muted-foreground">
                      Metadata
                    </TableHead>
                    <TableHead className="min-w-[240px] text-xs uppercase tracking-wide text-muted-foreground">
                      YouTube Accounts
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length ? (
                    rows.map((row) => (
                      <TableRow key={row.id}>
                        {/* User Info */}
                        <TableCell className="align-top">
                          <div className="font-medium">
                            {row.email || "(no email)"}
                          </div>
                          {row.phone && (
                            <div className="text-xs text-muted-foreground">
                              Phone: {row.phone}
                            </div>
                          )}
                          <div className="mt-1 flex items-center gap-1">
                            {row.is_anonymous && (
                              <Badge variant="outline" className="text-xs">
                                Anonymous
                              </Badge>
                            )}
                          </div>
                        </TableCell>

                        {/* User ID */}
                        <TableCell className="align-top">
                          <CopyableId id={row.id} label="User ID" />
                        </TableCell>

                        {/* Role / Aud */}
                        <TableCell className="align-top">
                          <div className="space-y-1 text-xs">
                            <div>
                              <span className="text-muted-foreground">Role: </span>
                              {row.role ?? "-"}
                            </div>
                            <div>
                              <span className="text-muted-foreground">Aud: </span>
                              {row.aud ?? "-"}
                            </div>
                          </div>
                        </TableCell>

                        {/* Confirmation */}
                        <TableCell className="align-top">
                          <div className="space-y-1 text-xs">
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">Email: </span>
                              {row.email_confirmed_at ? (
                                <Badge variant="secondary" className="text-xs">
                                  Confirmed
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-xs">
                                  Unconfirmed
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">Phone: </span>
                              {row.phone_confirmed_at ? (
                                <Badge variant="secondary" className="text-xs">
                                  Confirmed
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-xs">
                                  -
                                </Badge>
                              )}
                            </div>
                          </div>
                        </TableCell>

                        {/* Timestamps */}
                        <TableCell className="align-top">
                          <div className="space-y-1 text-xs text-muted-foreground">
                            <div>Created: {formatTime(row.created_at)}</div>
                            <div>Confirmed: {formatTime(row.confirmed_at)}</div>
                            <div>Last Sign-In: {formatTime(row.last_sign_in_at)}</div>
                          </div>
                        </TableCell>

                        {/* Quota */}
                        <TableCell className="align-top">
                          {row.quota ? (
                            (() => {
                              const videoTotal = row.quota.video_seconds_total ?? 0;
                              const videoRemaining = row.quota.video_seconds_remaining ?? 0;
                              const videoUsed = Math.max(0, videoTotal - videoRemaining);
                              const videoPercent =
                                videoTotal > 0 ? Math.min(100, (videoUsed / videoTotal) * 100) : 0;
                              const chatTotal = row.quota.chat_seconds_total ?? 0;
                              const chatRemaining = row.quota.chat_seconds_remaining ?? 0;
                              const chatUsed = Math.max(0, chatTotal - chatRemaining);

                              return (
                                <div className="space-y-1">
                                  <div className="font-medium text-sm">
                                    Video: {formatSeconds(videoUsed)} / {formatSeconds(videoTotal)}
                                  </div>
                                  <div className="w-full bg-muted rounded-full h-2">
                                    <div
                                      className={`h-2 rounded-full transition-all ${
                                        videoPercent >= 100
                                          ? "bg-destructive"
                                          : videoPercent >= 80
                                            ? "bg-yellow-500"
                                            : "bg-primary"
                                      }`}
                                      style={{ width: `${videoPercent}%` }}
                                    />
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {formatSeconds(videoRemaining)} remaining - Max{" "}
                                    {formatSeconds(row.quota.max_video_seconds)}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    Chat: {formatSeconds(chatUsed)} / {formatSeconds(chatTotal)}
                                  </div>
                                </div>
                              );
                            })()
                          ) : (
                            <span className="text-xs text-muted-foreground">No quota</span>
                          )}
                        </TableCell>

                        {/* Metadata */}
                        <TableCell className="align-top">
                          <div className="flex flex-col gap-1">
                            <MetadataCell data={row.app_metadata} title="App Metadata" />
                            <MetadataCell data={row.user_metadata} title="User Metadata" />
                          </div>
                        </TableCell>

                        {/* YouTube Accounts */}
                        <TableCell className="align-top">
                          <AccountsCell accounts={row.youtube_accounts} />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                        No users found
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
                    Page {page} of {totalPages} · Showing {rows.length} of {total} users
                  </span>
                  <Select value={String(pageSize)} onValueChange={handlePageSizeChange}>
                    <SelectTrigger className="h-8 w-[120px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Pagination>
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                        className={page === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                      />
                    </PaginationItem>

                    {getPageNumbers().map((pageNum, index) =>
                      pageNum === "ellipsis" ? (
                        <PaginationItem key={`ellipsis-${index}`}>
                          <PaginationEllipsis />
                        </PaginationItem>
                      ) : (
                        <PaginationItem key={pageNum}>
                          <PaginationLink
                            onClick={() => setPage(pageNum)}
                            isActive={page === pageNum}
                            className="cursor-pointer"
                          >
                            {pageNum}
                          </PaginationLink>
                        </PaginationItem>
                      )
                    )}

                    <PaginationItem>
                      <PaginationNext
                        onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                        className={page >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
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
  );
}
