import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../lib/auth";
import { fetchSystemUsers, type SystemUserRow, type YoutubeAccountSummary } from "../lib/jobsApi";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Alert, AlertDescription } from "./ui/alert";
import { Skeleton } from "./ui/skeleton";
import { Badge } from "./ui/badge";

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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
          <div className="mt-2 text-[11px] text-muted-foreground break-words">
            Scope: {account.scope ?? "-"}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SystemUsers() {
  const { session } = useAuth();
  const token = session?.access_token;

  const usersQuery = useQuery({
    queryKey: ["system-users"],
    enabled: Boolean(token),
    queryFn: () => fetchSystemUsers(token ?? "")
  });

  const rows: SystemUserRow[] = usersQuery.data?.rows ?? [];
  const accountCount = rows.reduce((total, row) => total + row.youtube_accounts.length, 0);

  return (
    <Card className="border-border/70 bg-card/80 shadow-sm backdrop-blur">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>System Users</CardTitle>
          <CardDescription>All users and their linked YouTube accounts.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{rows.length} users</Badge>
          <Badge variant="outline">{accountCount} accounts</Badge>
        </div>
      </CardHeader>
      <CardContent>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                  Email
                </TableHead>
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                  User ID
                </TableHead>
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                  Created
                </TableHead>
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                  Last Sign-In
                </TableHead>
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                  YouTube Accounts
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length ? (
                rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">
                      {row.email || "(no email)"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.id.slice(0, 8)}...
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatTime(row.created_at)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatTime(row.last_sign_in_at)}
                    </TableCell>
                    <TableCell className="min-w-[240px]">
                      <AccountsCell accounts={row.youtube_accounts} />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No users found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
