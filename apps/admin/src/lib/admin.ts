import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export function useAdminAccess() {
  const { session } = useAuth();

  return useQuery({
    queryKey: ["admin-access", session?.user.id],
    enabled: Boolean(session?.user.id),
    queryFn: async () => {
      if (!session?.user.id) {
        return false;
      }

      const { data, error } = await supabase
        .from("admin_users")
        .select("user_id")
        .eq("user_id", session.user.id)
        .maybeSingle();

      if (error) {
        throw error;
      }

      return Boolean(data);
    }
  });
}