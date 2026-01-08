import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  PaginationEllipsis,
} from "./ui/pagination";
import { ChevronDown, ChevronUp, Eye, Loader2, RefreshCw, Sparkles } from "lucide-react";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "active", label: "Active" },
  { value: "error", label: "Error" }
];

const ANALYSIS_STATUS_OPTIONS = [
  { value: "all", label: "All analysis statuses" },
  { value: "none", label: "No analysis" },
  { value: "queued", label: "Queued" },
  { value: "processing", label: "Processing" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" }
];

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
        <span className="text-xs opacity-70">Click to copy</span>
      </TooltipContent>
    </Tooltip>
  );
}

type DetailDialogData = {
  title: string;
  content: string;
} | null;

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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // UI state
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailDialog, setDetailDialog] = useState<DetailDialogData>(null);

  const videosQuery = useQuery({
    queryKey: ["admin-videos", filters, page, pageSize],
    enabled: Boolean(token),
    queryFn: () =>
      fetchAdminVideos(token ?? "", {
        ...filters,
        limit: pageSize,
        offset: (page - 1) * pageSize
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
  const hasNextPage = rows.length === pageSize;
  const totalPages = hasNextPage ? page + 1 : page;

  const handleApply = (event: React.FormEvent) => {
    event.preventDefault();
    setFilters({
      userId: formUserId.trim() || undefined,
      youtubeVideoId: formYoutubeVideoId.trim() || undefined,
      title: formTitle.trim() || undefined,
      status: formStatus === "all" ? undefined : formStatus,
      analysisStatus: formAnalysisStatus === "all" ? undefined : formAnalysisStatus
    });
    setPage(1);
  };

  const handleReset = () => {
    setFormUserId("");
    setFormYoutubeVideoId("");
    setFormTitle("");
    setFormStatus("all");
    setFormAnalysisStatus("all");
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
                  <Label htmlFor="filter-user">User ID</Label>
                  <Input
                    id="filter-user"
                    placeholder="Filter by user UUID"
                    value={formUserId}
                    onChange={(e) => setFormUserId(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="filter-youtube-video">YouTube Video ID</Label>
                  <Input
                    id="filter-youtube-video"
                    placeholder="e.g. dQw4w9WgXcQ"
                    value={formYoutubeVideoId}
                    onChange={(e) => setFormYoutubeVideoId(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="filter-title">Title (contains)</Label>
                  <Input
                    id="filter-title"
                    placeholder="Search by title"
                    value={formTitle}
                    onChange={(e) => setFormTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="filter-status">Status</Label>
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
                  <Label htmlFor="filter-analysis-status">Analysis Status</Label>
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
                  Apply Filters
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleReset}>
                  Reset
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
              Failed to load videos: {String(videosQuery.error)}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[200px] text-xs uppercase tracking-wide text-muted-foreground">
                      Video
                    </TableHead>
                    <TableHead className="min-w-[140px] text-xs uppercase tracking-wide text-muted-foreground">
                      IDs
                    </TableHead>
                    <TableHead className="min-w-[100px] text-xs uppercase tracking-wide text-muted-foreground">
                      Status
                    </TableHead>
                    <TableHead className="min-w-[100px] text-xs uppercase tracking-wide text-muted-foreground">
                      Analysis
                    </TableHead>
                    <TableHead className="min-w-[140px] text-xs uppercase tracking-wide text-muted-foreground">
                      Timestamps
                    </TableHead>
                    <TableHead className="min-w-[100px] text-xs uppercase tracking-wide text-muted-foreground">
                      Details
                    </TableHead>
                    <TableHead className="min-w-[100px] text-xs uppercase tracking-wide text-muted-foreground">
                      Action
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length ? (
                    rows.map((row) => {
                      const analysisStatus = row.analysis_status ?? "";
                      const isLocked = analysisStatus === "queued" || analysisStatus === "processing";
                      const canAnalyze = row.status === "active" && !isLocked;
                      const isPending = analyzeMutation.isPending && analyzeMutation.variables?.id === row.id;

                      return (
                        <TableRow key={row.id}>
                          {/* Video Info */}
                          <TableCell className="align-top">
                            <div className="font-medium">
                              <TruncatedText text={row.title} maxLength={40} />
                            </div>
                            <div className="text-xs text-muted-foreground">
                              YT: {row.youtube_video_id}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Duration: {row.duration ?? "-"}
                            </div>
                          </TableCell>

                          {/* IDs */}
                          <TableCell className="align-top">
                            <div className="space-y-1">
                              <div className="text-xs">
                                <span className="text-muted-foreground">Video: </span>
                                <CopyableId id={row.id} />
                              </div>
                              <div className="text-xs">
                                <span className="text-muted-foreground">User: </span>
                                <CopyableId id={row.user_id} />
                              </div>
                            </div>
                          </TableCell>

                          {/* Status */}
                          <TableCell className="align-top">
                            <Badge variant={getStatusBadgeVariant(row.status)} className="capitalize">
                              {row.status}
                            </Badge>
                            {row.removed_at && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                Removed: {formatTime(row.removed_at)}
                              </div>
                            )}
                          </TableCell>

                          {/* Analysis Status */}
                          <TableCell className="align-top">
                            <Badge variant={getAnalysisBadgeVariant(row.analysis_status)}>
                              {row.analysis_status ?? "none"}
                            </Badge>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {row.analysis_count} total
                            </div>
                            {row.analysis_model && (
                              <div className="text-xs text-muted-foreground">
                                {row.analysis_model}
                              </div>
                            )}
                          </TableCell>

                          {/* Timestamps */}
                          <TableCell className="align-top">
                            <div className="space-y-1 text-xs text-muted-foreground">
                              <div>Created: {formatTime(row.created_at)}</div>
                              {row.analysis_created_at && (
                                <div>Analysis: {formatTime(row.analysis_created_at)}</div>
                              )}
                            </div>
                          </TableCell>

                          {/* Detail Buttons */}
                          <TableCell className="align-top">
                            <div className="flex flex-wrap gap-1">
                              {row.analysis_text && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2"
                                  onClick={() =>
                                    setDetailDialog({
                                      title: "Analysis Result",
                                      content: row.analysis_text ?? ""
                                    })
                                  }
                                >
                                  <Eye className="mr-1 h-3 w-3" />
                                  Text
                                </Button>
                              )}
                              {row.analysis_error && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-destructive"
                                  onClick={() =>
                                    setDetailDialog({
                                      title: "Analysis Error",
                                      content: row.analysis_error ?? ""
                                    })
                                  }
                                >
                                  <Eye className="mr-1 h-3 w-3" />
                                  Error
                                </Button>
                              )}
                            </div>
                          </TableCell>

                          {/* Action */}
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
                                    : "Only active videos can be analyzed"}
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                        No videos found for the current filters.
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
                    Page {page} · Showing {rows.length} videos
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

        {/* Detail Dialog */}
        <Dialog open={!!detailDialog} onOpenChange={() => setDetailDialog(null)}>
          <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
            <DialogHeader>
              <DialogTitle>{detailDialog?.title}</DialogTitle>
              <DialogDescription>Full content view</DialogDescription>
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
