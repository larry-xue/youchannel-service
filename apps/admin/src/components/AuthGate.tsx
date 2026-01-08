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
              <span>正在检查会话...</span>
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
              <span>正在验证管理员访问权限...</span>
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
            <CardTitle>管理员验证失败</CardTitle>
            <CardDescription>
              无法验证管理员访问权限。请重试。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive" className="mb-4 border-destructive/60 bg-destructive/5">
              <AlertDescription>
                {String(adminAccess.error)}
              </AlertDescription>
            </Alert>
            <Button variant="outline" onClick={() => adminAccess.refetch()} className="w-full">
              重试
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
            <CardTitle>访问被阻止</CardTitle>
            <CardDescription>
              您的账户不在管理员白名单中。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => supabase.auth.signOut()} className="w-full">
              退出登录
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <Outlet />;
}
