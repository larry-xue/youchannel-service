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
      setError("Email is required");
      return;
    }
    if (createNew && !password.trim()) {
      setError("Password is required when creating new user");
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
          <CardTitle>Add Admin User</CardTitle>
          <CardDescription>
            Add a new administrator by email address. You can add an existing user or create a new one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
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
                    Create new user if missing
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Enable this to create a new account and set an initial password.
                  </p>
                </div>
              </div>
            </div>
            {createNew && (
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Set a temporary password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={addMutation.isPending}
                  required={createNew}
                />
                <p className="text-xs text-muted-foreground">
                  Minimum 6 characters. Ask the user to rotate it after first login.
                </p>
              </div>
            )}
            <Button type="submit" className="w-full" disabled={addMutation.isPending}>
              {addMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {createNew ? "Creating..." : "Adding..."}
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" />
                  {createNew ? "Create & Add" : "Add Admin"}
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
            <CardTitle>Admin Users</CardTitle>
            <CardDescription>
              List of all users with administrator access.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{rows.length} admins</Badge>
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
                Failed to load admin users: {String(adminUsersQuery.error)}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                <div className="space-y-1">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Search
                  </Label>
                  <Input
                    placeholder="Filter by email, ID, phone, or role"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Confirmed
                  </Label>
                  <Select
                    value={confirmedFilter}
                    onValueChange={(value) => setConfirmedFilter(value as ConfirmedFilter)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="All statuses" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="confirmed">Email confirmed</SelectItem>
                      <SelectItem value="unconfirmed">Email not confirmed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Last sign-in
                  </Label>
                  <Select
                    value={signinFilter}
                    onValueChange={(value) => setSigninFilter(value as SignInFilter)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Any time" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Any time</SelectItem>
                      <SelectItem value="recent">Last 30 days</SelectItem>
                      <SelectItem value="never">Never signed in</SelectItem>
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
                    Reset filters
                  </Button>
                </div>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{filteredCount} shown</Badge>
                {filtersActive && <Badge variant="secondary">Filters active</Badge>}
              </div>
              <TooltipProvider>
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
                        Admin since
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        Created
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        Last sign-in
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        Confirmed
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        Phone
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        Identities
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        Metadata
                      </TableHead>
                      <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                        Actions
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
                                <span className="font-medium">{row.email || "(no email)"}</span>
                                <Badge variant="outline" className="text-[11px]">
                                  {row.role ?? row.aud ?? "user"}
                                </Badge>
                              </div>
                              {row.aud && (
                                <div className="text-[11px] text-muted-foreground">
                                  Audience: {row.aud}
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
                                  Email {emailConfirmed ? "confirmed" : "pending"}
                                </Badge>
                                {row.phone && (
                                  <Badge
                                    variant={phoneConfirmed ? "secondary" : "outline"}
                                    className="text-[11px]"
                                  >
                                    Phone {phoneConfirmed ? "confirmed" : "pending"}
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
                                      {row.identities.length} identity
                                      {row.identities.length > 1 ? "s" : ""}
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent className="text-xs leading-relaxed">
                                    {identitySummary}
                                  </TooltipContent>
                                </Tooltip>
                              ) : (
                                <span className="text-xs text-muted-foreground">None</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <Button variant="ghost" size="sm">
                                    Details
                                  </Button>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>
                                      Metadata for {row.email ?? row.user_id}
                                    </DialogTitle>
                                    <DialogDescription>
                                      Full Supabase user payload and linked identities.
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="space-y-4 text-xs">
                                    <div>
                                      <p className="text-[11px] font-semibold text-muted-foreground">
                                        App metadata
                                      </p>
                                      <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-border/70 bg-muted/40 p-3 font-mono text-[11px] text-muted-foreground">
{metadataToJson(row.app_metadata)}
                                      </pre>
                                    </div>
                                    <div>
                                      <p className="text-[11px] font-semibold text-muted-foreground">
                                        User metadata
                                      </p>
                                      <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-border/70 bg-muted/40 p-3 font-mono text-[11px] text-muted-foreground">
{metadataToJson(row.user_metadata)}
                                      </pre>
                                    </div>
                                    <div>
                                      <p className="text-[11px] font-semibold text-muted-foreground">
                                        Identities
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
                                          No linked identities.
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                  <DialogFooter>
                                    <DialogClose asChild>
                                      <Button variant="outline" size="sm">
                                        Close
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
                                    ? "Cannot remove your own access"
                                    : "Remove admin user"
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
                          No admin users found
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TooltipProvider>
              {filteredCount > rowsPerPage && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>
                    Showing {startIndex}-{endIndex} of {filteredCount}
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
            <DialogTitle>Remove Admin User</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove this admin user? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmRemove} disabled={removeMutation.isPending}>
              {removeMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Removing...
                </>
              ) : (
                "Remove"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
