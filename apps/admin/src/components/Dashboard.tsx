import { useMutation, useQuery } from "@tanstack/react-query";
import { kickoff, fetchSyncRuns } from "../lib/jobsApi";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Alert, AlertDescription } from "./ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { LogOut, Play, Users } from "lucide-react";
import { useState } from "react";
import { AdminUsers } from "./AdminUsers";

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function StatusBadge({ status }: { status: string }) {
  const variantMap: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    queued: "secondary",
    running: "default",
    succeeded: "default",
    failed: "destructive",
  };

  return (
    <Badge variant={variantMap[status] || "outline"} className="capitalize">
      {status}
    </Badge>
  );
}

type Tab = "dashboard" | "users";

export function Dashboard() {
  const { session } = useAuth();
  const token = session?.access_token;
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");

  const syncRunsQuery = useQuery({
    queryKey: ["sync-runs"],
    enabled: Boolean(token) && activeTab === "dashboard",
    queryFn: () => fetchSyncRuns(token ?? "")
  });

  const kickoffMutation = useMutation({
    mutationFn: () => kickoff(token ?? ""),
    onSuccess: () => syncRunsQuery.refetch()
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Jobs Control Room
          </p>
          <h1 className="text-4xl font-bold tracking-tight mt-2">
            YouChannel Operations
          </h1>
          <p className="text-muted-foreground mt-2">
            Queue sync runs, review history, and keep the pipeline healthy.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeTab === "dashboard" && (
            <Button
              onClick={() => kickoffMutation.mutate()}
              disabled={kickoffMutation.isPending}
              size="lg"
            >
              <Play className="mr-2 h-4 w-4" />
              {kickoffMutation.isPending ? "Enqueuing..." : "Kickoff Sync"}
            </Button>
          )}
          <Button
            variant={activeTab === "users" ? "default" : "outline"}
            onClick={() => setActiveTab(activeTab === "users" ? "dashboard" : "users")}
            size="lg"
          >
            <Users className="mr-2 h-4 w-4" />
            {activeTab === "users" ? "Dashboard" : "Admin Users"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => supabase.auth.signOut()}
            size="lg"
          >
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </div>
      </div>

      {activeTab === "users" ? (
        <AdminUsers />
      ) : (
        <>
          {kickoffMutation.error && (
            <Alert variant="destructive">
              <AlertDescription>
                Kickoff failed: {String(kickoffMutation.error)}
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Recent Sync Runs</CardTitle>
              <CardDescription>
                View the history of sync job executions
              </CardDescription>
            </CardHeader>
            <CardContent>
              {syncRunsQuery.isLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : syncRunsQuery.error ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    Failed to load runs: {String(syncRunsQuery.error)}
                  </AlertDescription>
                </Alert>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Finished</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {syncRunsQuery.data?.rows?.length ? (
                      syncRunsQuery.data.rows.map((row) => (
                        <TableRow key={row.id as string}>
                          <TableCell className="font-mono text-xs">
                            {(row.id as string).slice(0, 8)}...
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={row.status as string} />
                          </TableCell>
                          <TableCell>{row.kickoff_source as string}</TableCell>
                          <TableCell>{formatTime(row.created_at as string)}</TableCell>
                          <TableCell>{formatTime(row.started_at as string)}</TableCell>
                          <TableCell>{formatTime(row.finished_at as string)}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                          No sync runs yet. Kick one off to begin.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
