export type SyncRunStatus = "queued" | "running" | "succeeded" | "failed" | "partial";
export type JobRunStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";

export type SyncRunRow = {
  id: string;
  status: SyncRunStatus;
  kickoff_source: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  meta: Record<string, unknown>;
};

export type JobRunRow = {
  id: string;
  sync_run_id: string;
  user_id: string | null;
  job_name: string;
  status: JobRunStatus;
  boss_job_id: string | null;
  attempt: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
};



