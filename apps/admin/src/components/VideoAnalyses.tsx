import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { fetchVideoAnalyses, deleteAnalysis, type VideoAnalysisRow } from "../lib/jobsApi";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { useToast } from "../hooks/use-toast";
import { ArrowLeft, Eye, RefreshCw, Trash2, AlertTriangle } from "lucide-react";
import { useState } from "react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getStatusBadgeVariant(status: string | null) {
  if (!status) return "outline";
  if (status === "completed") return "secondary";
  if (status === "failed") return "destructive";
  if (status === "queued" || status === "processing") return "default";
  return "outline";
}

function translateStatus(status: string | null) {
  if (!status) return "未知";
  const statusMap: Record<string, string> = {
    queued: "已排队",
    processing: "处理中",
    completed: "已完成",
    failed: "失败"
  };
  return statusMap[status] ?? status;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type DetailDialogData = {
  title: string;
  content: string;
  isJson: boolean;
} | null;

export function VideoAnalyses() {
  const { session } = useAuth();
  const token = session?.access_token;
  const { videoId } = useParams({ from: "/auth/videos/$videoId/analyses" });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [detailDialog, setDetailDialog] = useState<DetailDialogData>(null);
  const [deletingAnalysis, setDeletingAnalysis] = useState<VideoAnalysisRow | null>(null);

  const analysesQuery = useQuery({
    queryKey: ["video-analyses", videoId],
    enabled: Boolean(token) && Boolean(videoId),
    queryFn: () => fetchVideoAnalyses(token ?? "", videoId!)
  });

  const deleteMutation = useMutation({
    mutationFn: async (analysisId: string) => {
      if (!token) throw new Error("No token");
      return deleteAnalysis(token, analysisId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["video-analyses", videoId] });
      setDeletingAnalysis(null);
      toast({
        title: "删除成功",
        description: "分析记录已删除",
        type: "success"
      });
    },
    onError: (error) => {
      toast({
        title: "删除失败",
        description: String(error),
        type: "error"
      });
    }
  });

  const analyses = analysesQuery.data?.analyses ?? [];

  const openJsonDialog = (title: string, content: string) => {
    const parsed = tryParseJson(content);
    setDetailDialog({
      title,
      content,
      isJson: parsed !== null
    });
  };

  return (
    <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link to="/videos">
            <Button variant="outline" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              返回
            </Button>
          </Link>
          <div>
            <CardTitle>视频分析记录</CardTitle>
            <CardDescription>
              视频 ID: {videoId}
            </CardDescription>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{analyses.length} 条记录</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => analysesQuery.refetch()}
            disabled={analysesQuery.isFetching}
          >
            <RefreshCw className={analysesQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {analysesQuery.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : analysesQuery.error ? (
          <Alert variant="destructive" className="border-destructive/60 bg-destructive/5">
            <AlertDescription>
              加载分析记录失败: {String(analysesQuery.error)}
            </AlertDescription>
          </Alert>
        ) : analyses.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            该视频暂无分析记录。
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">状态</TableHead>
                  <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">模型</TableHead>
                  <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">提示词</TableHead>
                  <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">创建时间</TableHead>
                  <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">更新时间</TableHead>
                  <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {analyses.map((analysis: VideoAnalysisRow) => (
                  <TableRow key={analysis.id}>
                    <TableCell>
                      <Badge variant={getStatusBadgeVariant(analysis.status)}>
                        {translateStatus(analysis.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{analysis.model || "-"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatTime(analysis.created_at)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatTime(analysis.updated_at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {analysis.analysis_text && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => openJsonDialog("分析结果", analysis.analysis_text ?? "")}
                          >
                            <Eye className="mr-1 h-3 w-3" />
                            结果
                          </Button>
                        )}
                        {analysis.error && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-destructive"
                            onClick={() =>
                              setDetailDialog({
                                title: "错误信息",
                                content: analysis.error ?? "",
                                isJson: false
                              })
                            }
                          >
                            <Eye className="mr-1 h-3 w-3" />
                            错误
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setDeletingAnalysis(analysis)}
                        >
                          <Trash2 className="mr-1 h-3 w-3" />
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Detail Dialog */}
        <Dialog open={!!detailDialog} onOpenChange={() => setDetailDialog(null)}>
          <DialogContent className="max-h-[80vh] max-w-3xl overflow-hidden">
            <DialogHeader>
              <DialogTitle>{detailDialog?.title}</DialogTitle>
              <DialogDescription>完整内容视图</DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-auto rounded-lg bg-muted/50 p-4">
              {detailDialog?.isJson ? (
                <JsonView
                  src={tryParseJson(detailDialog.content)}
                  theme="github"
                  collapsed={2}
                  enableClipboard
                  style={{ fontSize: "0.875rem" }}
                />
              ) : (
                <pre className="whitespace-pre-wrap break-words text-sm">
                  {detailDialog?.content}
                </pre>
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <Dialog open={!!deletingAnalysis} onOpenChange={(open) => !open && setDeletingAnalysis(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                删除分析记录
              </DialogTitle>
              <DialogDescription>
                您确定要删除此分析记录吗？此操作无法撤销。
              </DialogDescription>
            </DialogHeader>

            {deletingAnalysis && (
              <div className="py-2 text-sm">
                <p>状态: <span className="font-semibold">{translateStatus(deletingAnalysis.status)}</span></p>
                <p>模型: <span className="font-semibold">{deletingAnalysis.model || "-"}</span></p>
                <p>创建时间: <span className="font-semibold">{formatTime(deletingAnalysis.created_at)}</span></p>
              </div>
            )}

            {deleteMutation.error && (
              <Alert variant="destructive" className="my-2 p-2">
                <div className="text-sm">
                  {String(deleteMutation.error)}
                </div>
              </Alert>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDeletingAnalysis(null)}
                disabled={deleteMutation.isPending}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={() => deletingAnalysis && deleteMutation.mutate(deletingAnalysis.id)}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "正在删除..." : "确认删除"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
