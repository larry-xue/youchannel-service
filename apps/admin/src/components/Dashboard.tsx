import { useMutation, useQuery } from "@tanstack/react-query";
import { kickoff, fetchSyncRuns } from "../lib/jobsApi";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function Dashboard() {
  const { session } = useAuth();
  const token = session?.access_token;

  const syncRunsQuery = useQuery({
    queryKey: ["sync-runs"],
    enabled: Boolean(token),
    queryFn: () => fetchSyncRuns(token ?? "")
  });

  const kickoffMutation = useMutation({
    mutationFn: () => kickoff(token ?? ""),
    onSuccess: () => syncRunsQuery.refetch()
  });

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <div className="eyebrow">Jobs Control Room</div>
          <h1>YouChannel Operations</h1>
          <p className="muted">Queue sync runs, review history, and keep the pipeline healthy.</p>
        </div>
        <div className="header-actions">
          <button
            className="primary"
            onClick={() => kickoffMutation.mutate()}
            disabled={kickoffMutation.isPending}
          >
            {kickoffMutation.isPending ? "Enqueuing..." : "Kickoff Sync"}
          </button>
          <button className="ghost" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>
      {kickoffMutation.error ? (
        <div className="error">Kickoff failed: {String(kickoffMutation.error)}</div>
      ) : null}

      <section className="card list-card">
        <div className="card-title">Recent Sync Runs</div>
        {syncRunsQuery.isLoading ? (
          <div className="muted">Loading runs...</div>
        ) : syncRunsQuery.error ? (
          <div className="error">Failed to load runs: {String(syncRunsQuery.error)}</div>
        ) : (
          <div className="table">
            <div className="row header">
              <div>ID</div>
              <div>Status</div>
              <div>Source</div>
              <div>Created</div>
              <div>Started</div>
              <div>Finished</div>
            </div>
            {syncRunsQuery.data?.rows?.length ? (
              syncRunsQuery.data.rows.map((row) => (
                <div className="row" key={row.id as string}>
                  <div className="mono">{(row.id as string).slice(0, 8)}...</div>
                  <div className={`status status-${row.status}`}>{row.status as string}</div>
                  <div>{row.kickoff_source as string}</div>
                  <div>{formatTime(row.created_at as string)}</div>
                  <div>{formatTime(row.started_at as string)}</div>
                  <div>{formatTime(row.finished_at as string)}</div>
                </div>
              ))
            ) : (
              <div className="empty">No sync runs yet. Kick one off to begin.</div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
