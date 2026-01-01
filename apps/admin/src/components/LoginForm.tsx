import React, { useState } from "react";
import { supabase } from "../lib/supabase";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Alert, AlertDescription } from "./ui/alert";

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
          <CardTitle>Password Reset Email Sent</CardTitle>
          <CardDescription>
            Check your email for a password reset link
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert className="border-border/70 bg-muted/40">
            <AlertDescription>
              If an account exists with {email}, you will receive a password reset link.
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
            Back to Sign In
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cardClassName}>
      <CardHeader>
        <CardTitle>{resetMode ? "Reset Password" : "Admin Sign In"}</CardTitle>
        <CardDescription>
          {resetMode
            ? "Enter your email to receive a password reset link"
            : "Enter your credentials to access the admin console"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
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
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
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
                  ? "Sending..."
                  : "Signing in..."
                : resetMode
                  ? "Send Reset Link"
                  : "Sign in"}
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
                Forgot password?
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
                Back to Sign In
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
