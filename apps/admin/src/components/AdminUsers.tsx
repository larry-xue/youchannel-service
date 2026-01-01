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
    if (confirm("Are you sure you want to remove this admin user?")) {
      removeMutation.mutate(userId);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
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
                placeholder="user@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={addMutation.isPending}
                required
              />
            </div>
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="createNew"
                checked={createNew}
                onChange={(e) => {
                  setCreateNew(e.target.checked);
                  if (!e.target.checked) {
                    setPassword("");
                  }
                }}
                disabled={addMutation.isPending}
                className="h-4 w-4 rounded border-gray-300"
              />
              <Label htmlFor="createNew" className="text-sm font-normal cursor-pointer">
                Create new user if doesn't exist
              </Label>
            </div>
            {createNew && (
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter password for new user"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={addMutation.isPending}
                  required={createNew}
                />
                <p className="text-xs text-muted-foreground">
                  Minimum 6 characters. Use a strong password for security.
                </p>
              </div>
            )}
            <Button type="submit" className="w-full" disabled={addMutation.isPending}>
              {addMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {createNew ? "Creating..." : "Adding..."}
                </>
              ) : (
                <>
                  <Plus className="mr-2 h-4 w-4" />
                  {createNew ? "Create & Add" : "Add"}
                </>
              )}
            </Button>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Admin Users</CardTitle>
          <CardDescription>
            List of all users with administrator access
          </CardDescription>
        </CardHeader>
        <CardContent>
          {adminUsersQuery.isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : adminUsersQuery.error ? (
            <Alert variant="destructive">
              <AlertDescription>
                Failed to load admin users: {String(adminUsersQuery.error)}
              </AlertDescription>
            </Alert>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>User ID</TableHead>
                  <TableHead>Added At</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {adminUsersQuery.data?.rows?.length ? (
                  adminUsersQuery.data.rows.map((row) => (
                    <TableRow key={row.user_id}>
                      <TableCell className="font-medium">
                        {row.email || "(no email)"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.user_id.slice(0, 8)}...
                      </TableCell>
                      <TableCell>{formatTime(row.created_at)}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemove(row.user_id)}
                          disabled={removeMutation.isPending || row.user_id === session?.user.id}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                      No admin users found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
