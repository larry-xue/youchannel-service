import { LoginForm } from "./LoginForm";
import { useAdminAccess } from "../lib/admin";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { Dashboard } from "./Dashboard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Alert, AlertDescription } from "./ui/alert";
import { Skeleton } from "./ui/skeleton";
import { Loader2 } from "lucide-react";

export function AuthGate() {
  const { session, loading } = useAuth();
  const adminAccess = useAdminAccess();

  if (loading) {
    return (
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <div className="flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Checking session...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!session) {
    return <LoginForm />;
  }

  if (adminAccess.isLoading) {
    return (
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <div className="flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Validating admin access...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (adminAccess.error) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Admin check failed</CardTitle>
          <CardDescription>
            Unable to validate admin access. Please retry.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>
              {String(adminAccess.error)}
            </AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => adminAccess.refetch()} className="w-full">
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!adminAccess.data) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Access blocked</CardTitle>
          <CardDescription>
            Your account is not on the admin whitelist.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => supabase.auth.signOut()} className="w-full">
            Sign out
          </Button>
        </CardContent>
      </Card>
    );
  }

  return <Dashboard />;
}
