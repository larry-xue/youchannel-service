import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    adminUser?: { id: string; email?: string | null };
  }
}

export function createAdminGuard(supabase: SupabaseClient) {
  return async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      reply.code(401).send({ error: "missing_token" });
      return;
    }

    const token = authHeader.slice("Bearer ".length);
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      reply.code(401).send({ error: "invalid_token" });
      return;
    }

    const { data: adminRow, error: adminError } = await supabase
      .from("admin_users")
      .select("user_id")
      .eq("user_id", data.user.id)
      .maybeSingle();

    if (adminError || !adminRow) {
      reply.code(403).send({ error: "not_admin" });
      return;
    }

    request.adminUser = { id: data.user.id, email: data.user.email };
  };
}