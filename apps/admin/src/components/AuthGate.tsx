import { LoginForm } from "./LoginForm";
import { useAdminAccess } from "../lib/admin";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { Outlet } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Alert, AlertDescription } from "./ui/alert";
import { Loader2 } from "lucide-react";

export function AuthGate() {
  const { session, loading } = useAuth();
  const adminAccess = useAdminAccess();
  const cardClassName = "w-full max-w-md border-border/70 bg-card/80 shadow-xl backdrop-blur";
  const centeredClassName = "flex min-h-[70vh] items-center justify-center";

  if (loading) {
    return (
      <div className={centeredClassName}>
        <Card className={cardClassName}>
          <CardContent className="pt-6">
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Checking session...</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!session) {
    return (
      <div className={centeredClassName}>
        <LoginForm />
      </div>
    );
  }

  if (adminAccess.isLoading) {
    return (
      <div className={centeredClassName}>
        <Card className={cardClassName}>
          <CardContent className="pt-6">
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Validating admin access...</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (adminAccess.error) {
    return (
      <div className={centeredClassName}>
        <Card className={cardClassName}>
          <CardHeader>
            <CardTitle>Admin check failed</CardTitle>
            <CardDescription>
              Unable to validate admin access. Please retry.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive" className="mb-4 border-destructive/60 bg-destructive/5">
              <AlertDescription>
                {String(adminAccess.error)}
              </AlertDescription>
            </Alert>
            <Button variant="outline" onClick={() => adminAccess.refetch()} className="w-full">
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!adminAccess.data) {
    return (
      <div className={centeredClassName}>
        <Card className={cardClassName}>
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
      </div>
    );
  }

  return <Outlet />;
}
