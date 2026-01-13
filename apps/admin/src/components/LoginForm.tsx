import React, { useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const cardClassName = "w-full max-w-md border-border/70 bg-card/80 shadow-xl backdrop-blur";

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    if (resetMode) {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`
      });

      if (resetError) {
        setError(resetError.message);
      } else {
        setResetSent(true);
      }
    } else {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password
      });

      if (signInError) {
        setError(signInError.message);
      }
    }

    setLoading(false);
  };

  if (resetSent) {
    return (
      <Card className={cardClassName}>
        <CardHeader>
          <CardTitle>密码重置邮件已发送</CardTitle>
          <CardDescription>
            请检查您的邮箱以获取密码重置链接
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert className="border-border/70 bg-muted/40">
            <AlertDescription>
              如果存在使用 {email} 的账户，您将收到密码重置链接。
            </AlertDescription>
          </Alert>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              setResetMode(false);
              setResetSent(false);
              setError(null);
            }}
          >
            返回登录
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cardClassName}>
      <CardHeader>
        <CardTitle>{resetMode ? "重置密码" : "管理员登录"}</CardTitle>
        <CardDescription>
          {resetMode
            ? "输入您的邮箱以接收密码重置链接"
            : "输入您的凭据以访问管理控制台"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="admin@company.com"
              autoComplete="email"
              disabled={loading}
            />
          </div>
          {!resetMode && (
            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="输入您的密码"
                autoComplete="current-password"
                disabled={loading}
              />
            </div>
          )}
          {error && (
            <Alert variant="destructive" className="border-destructive/60 bg-destructive/5">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading
                ? resetMode
                  ? "发送中..."
                  : "登录中..."
                : resetMode
                  ? "发送重置链接"
                  : "登录"}
            </Button>
            {!resetMode && (
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setResetMode(true);
                  setError(null);
                }}
                disabled={loading}
              >
                忘记密码？
              </Button>
            )}
            {resetMode && (
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setResetMode(false);
                  setError(null);
                }}
                disabled={loading}
              >
                返回登录
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
