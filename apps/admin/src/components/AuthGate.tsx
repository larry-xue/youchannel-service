import { LoginForm } from "./LoginForm";
import { useAdminAccess } from "../lib/admin";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { Dashboard } from "./Dashboard";

export function AuthGate() {
  const { session, loading } = useAuth();
  const adminAccess = useAdminAccess();

  if (loading) {
    return <div className="card">Checking session...</div>;
  }

  if (!session) {
    return <LoginForm />;
  }

  if (adminAccess.isLoading) {
    return <div className="card">Validating admin access...</div>;
  }

  if (adminAccess.error) {
    return (
      <div className="card">
        <div className="card-title">Admin check failed</div>
        <p className="muted">Unable to validate admin access. Please retry.</p>
        <button className="ghost" onClick={() => adminAccess.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  if (!adminAccess.data) {
    return (
      <div className="card">
        <div className="card-title">Access blocked</div>
        <p className="muted">Your account is not on the admin whitelist.</p>
        <button className="ghost" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </div>
    );
  }

  return <Dashboard />;
}
