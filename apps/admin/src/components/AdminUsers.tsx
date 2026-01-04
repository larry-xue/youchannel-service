import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../lib/auth";
import { fetchAdminUsers, addAdminUser, removeAdminUser } from "../lib/jobsApi";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Alert, AlertDescription } from "./ui/alert";
import { Skeleton } from "./ui/skeleton";
import { Badge } from "./ui/badge";
import { Switch } from "./ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useState } from "react";
import { Plus, Trash2, Loader2 } from "lucide-react";

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

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
              List of all users with administrator access
            </CardDescription>
          </div>
          <Badge variant="secondary">
            {adminUsersQuery.data?.rows?.length ?? 0} admins
          </Badge>
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
                    Added At
                  </TableHead>
                  <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                    Role
                  </TableHead>
                  <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {adminUsersQuery.data?.rows?.length ? (
                  adminUsersQuery.data.rows.map((row) => {
                    const isCurrentUser = row.user_id === session?.user.id;
                    return (
                      <TableRow key={row.user_id}>
                        <TableCell className="font-medium">
                          {row.email || "(no email)"}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {row.user_id.slice(0, 8)}...
                        </TableCell>
                        <TableCell className="text-sm">
                          {formatTime(row.created_at)}
                        </TableCell>
                        <TableCell>
                          {isCurrentUser ? (
                            <Badge variant="secondary">You</Badge>
                          ) : (
                            <Badge variant="outline">Admin</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span tabIndex={isCurrentUser ? 0 : undefined}>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleRemove(row.user_id)}
                                  disabled={removeMutation.isPending || isCurrentUser}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {isCurrentUser
                                ? "Cannot remove your own access"
                                : "Remove admin user"}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      No admin users found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
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
