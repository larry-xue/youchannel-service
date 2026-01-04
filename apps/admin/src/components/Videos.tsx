import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "../lib/auth";
import { enqueueAnalysis, fetchAdminVideos, type AdminVideoRow } from "../lib/jobsApi";
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
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "./ui/pagination";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "synced", label: "Synced" },
  { value: "removed", label: "Removed" },
  { value: "unavailable", label: "Unavailable" }
];

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function shortId(value: string | null | undefined) {
  if (!value) return "-";
  return `${value.slice(0, 8)}...`;
}

function getSyncBadgeVariant(status: string) {
  if (status === "synced") return "secondary";
  if (status === "removed") return "outline";
  if (status === "unavailable") return "destructive";
  return "outline";
}

function getAnalysisBadgeVariant(status: string | null) {
  if (!status) return "outline";
  if (status === "completed") return "secondary";
  if (status === "failed") return "destructive";
  return "outline";
}

export function Videos() {
  const { session } = useAuth();
  const token = session?.access_token;
  const queryClient = useQueryClient();
  const [formUserId, setFormUserId] = useState("");
  const [formStatus, setFormStatus] = useState("all");
  const [filters, setFilters] = useState({ userId: "", syncStatus: "all" });
  const [page, setPage] = useState(1);
  const [actionError, setActionError] = useState<string | null>(null);
  const limit = 50;

  const videosQuery = useQuery({
    queryKey: ["admin-videos", filters, page],
    enabled: Boolean(token),
    queryFn: () =>
      fetchAdminVideos(token ?? "", {
        userId: filters.userId || undefined,
        syncStatus: filters.syncStatus === "all" ? undefined : filters.syncStatus,
        limit,
        offset: (page - 1) * limit
      })
  });

  const analyzeMutation = useMutation({
    mutationFn: (row: AdminVideoRow) =>
      enqueueAnalysis(token ?? "", {
        playlistId: row.playlist_id,
        userId: row.playlist_user_id,
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
  const hasNextPage = rows.length === limit;

  const handleApply = (event: React.FormEvent) => {
    event.preventDefault();
    setFilters({
      userId: formUserId.trim(),
      syncStatus: formStatus
    });
    setPage(1);
  };

  const handleReset = () => {
    setFormUserId("");
    setFormStatus("all");
    setFilters({ userId: "", syncStatus: "all" });
    setPage(1);
  };

  return (
    <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Videos Library</CardTitle>
          <CardDescription>
            Filter videos and manually queue Gemini analysis for selected items.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{rows.length} videos</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => videosQuery.refetch()}
            disabled={videosQuery.isFetching}
          >
            <RefreshCw className={videosQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleApply} className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,220px)_auto_auto]">
          <div className="space-y-2">
            <Label htmlFor="filter-user">User ID</Label>
            <Input
              id="filter-user"
              placeholder="Filter by user UUID"
              value={formUserId}
              onChange={(event) => setFormUserId(event.target.value)}
              className="max-w-[360px]"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="filter-status">Sync status</Label>
            <Select value={formStatus} onValueChange={setFormStatus}>
              <SelectTrigger id="filter-status" className="h-10 w-full">
                <SelectValue placeholder="Select status" />
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
          <div className="flex items-end">
            <Button type="submit" className="w-full">
              Apply
            </Button>
          </div>
          <div className="flex items-end">
            <Button type="button" variant="outline" className="w-full" onClick={handleReset}>
              Reset
            </Button>
          </div>
        </form>

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
              Failed to load videos: {String(videosQuery.error)}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[260px] text-xs uppercase tracking-wide text-muted-foreground">
                    Video
                  </TableHead>
                  <TableHead className="w-[220px] text-xs uppercase tracking-wide text-muted-foreground">
                    User / Playlist
                  </TableHead>
                  <TableHead className="w-[140px] text-xs uppercase tracking-wide text-muted-foreground">
                    Sync
                  </TableHead>
                  <TableHead className="w-[260px] text-xs uppercase tracking-wide text-muted-foreground">
                    Analysis
                  </TableHead>
                  <TableHead className="w-[140px] text-xs uppercase tracking-wide text-muted-foreground">
                    Action
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length ? (
                  rows.map((row) => {
                    const analysisStatus = row.analysis_status ?? "";
                    const isLocked = analysisStatus === "queued" || analysisStatus === "processing";
                    const canAnalyze = row.sync_status === "synced" && !isLocked;
                    const isPending = analyzeMutation.isPending && analyzeMutation.variables?.id === row.id;
                    const analysisPreview = row.analysis_text ?? row.analysis_error ?? "";
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="align-top">
                          <div className="truncate font-medium">{row.title ?? "(untitled)"}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {row.youtube_video_id} · {shortId(row.id)}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            Duration: {row.duration ?? "-"} · Created: {formatTime(row.created_at)}
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="truncate text-sm">{shortId(row.playlist_user_id)}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            Playlist: {shortId(row.playlist_id)}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            YouTube: {row.playlist_youtube_id}
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge variant={getSyncBadgeVariant(row.sync_status)} className="capitalize">
                            {row.sync_status}
                          </Badge>
                          <div className="mt-2 truncate text-xs text-muted-foreground">
                            Last seen: {formatTime(row.last_seen_at)}
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex items-center gap-2">
                            <Badge variant={getAnalysisBadgeVariant(row.analysis_status)}>
                              {row.analysis_status ?? "none"}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {row.analysis_count} total
                            </span>
                          </div>
                          <div className="mt-2 truncate text-xs text-muted-foreground">
                            {row.analysis_model ? `${row.analysis_model} · ` : ""}
                            {formatTime(row.analysis_created_at)}
                          </div>
                          {analysisPreview && (
                            <div className="mt-2 truncate text-xs text-muted-foreground" title={analysisPreview}>
                              {analysisPreview}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="align-top">
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
                                      Queuing...
                                    </>
                                  ) : (
                                    <>
                                      <Sparkles className="h-4 w-4" />
                                      {row.analysis_status ? "Re-run" : "Analyze"}
                                    </>
                                  )}
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {canAnalyze
                                ? "Queue analysis"
                                : isLocked
                                  ? "Analysis is already queued or processing"
                                  : "Only synced videos can be analyzed"}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      No videos found for the current filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>

            {rows.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>
                  Page {page} · Showing {rows.length} videos
                </span>
                <Pagination>
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                        className={page === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                      />
                    </PaginationItem>
                    <PaginationItem>
                      <PaginationNext
                        onClick={() => setPage((prev) => prev + 1)}
                        className={!hasNextPage ? "pointer-events-none opacity-50" : "cursor-pointer"}
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
