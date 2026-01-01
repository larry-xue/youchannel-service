import type { PgBoss } from "pg-boss";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import Fastify from "fastify";
import cors from "@fastify/cors";
import type { Config } from "./config";
import { createAdminGuard } from "./admin-auth";
import { listJobRuns, listSyncRuns, type DbPool } from "./db";

export async function buildServer(params: {
  config: Config;
  logger: Logger;
  boss: PgBoss;
  db: DbPool;
  supabase: SupabaseClient;
}) {
  const { config, logger, boss, db, supabase } = params;
  const app = Fastify({ logger });

  await app.register(cors, {
    origin: config.adminOrigin,
    credentials: true
  });

  const requireAdmin = createAdminGuard(supabase);

  app.get("/health", async () => ({ ok: true }));

  app.post("/admin/kickoff", { preHandler: requireAdmin }, async (request) => {
    const bossJobId = await boss.publish("kickoff", {
      source: "manual",
      requestedBy: request.adminUser?.id
    });

    return { bossJobId };
  });

  app.get("/admin/sync-runs", { preHandler: requireAdmin }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 50);
    const rows = await listSyncRuns(db, Number.isFinite(limit) ? limit : 50);
    return { rows };
  });

  app.get("/admin/job-runs", { preHandler: requireAdmin }, async (request) => {
    const query = request.query as { syncRunId?: string; limit?: string };
    const limit = Number(query.limit ?? 50);
    const rows = await listJobRuns(db, {
      syncRunId: query.syncRunId,
      limit: Number.isFinite(limit) ? limit : 50
    });
    return { rows };
  });

  // Admin users management
  app.get("/admin/users", { preHandler: requireAdmin }, async () => {
    // Use service role to query admin_users and join with auth.users
    const { data, error } = await supabase
      .from("admin_users")
      .select(`
        user_id,
        created_at
      `)
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    // Get user emails from auth.users using admin API
    const { data: allUsers } = await supabase.auth.admin.listUsers();
    const userMap = new Map(allUsers.users.map((u) => [u.id, u.email]));

    return {
      rows: data.map((row: any) => ({
        user_id: row.user_id,
        created_at: row.created_at,
        email: userMap.get(row.user_id) || null
      }))
    };
  });

  app.post("/admin/users", { preHandler: requireAdmin }, async (request) => {
    const body = request.body as { email: string; password?: string; createIfNotExists?: boolean };
    if (!body.email) {
      return { error: "email is required" };
    }

    // Find user by email using admin API
    const { data: users, error: userError } = await supabase.auth.admin.listUsers();
    if (userError) {
      throw userError;
    }

    let user = users.users.find((u) => u.email?.toLowerCase() === body.email.toLowerCase());

    // Create user if not exists and password provided
    if (!user && body.createIfNotExists && body.password) {
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email: body.email,
        password: body.password,
        email_confirm: true
      });

      if (createError) {
        return { error: `Failed to create user: ${createError.message}` };
      }

      user = newUser.user;
    }

    if (!user) {
      return { error: "User not found. Set createIfNotExists=true and provide password to create user." };
    }

    // Add to admin_users (using service role)
    const { data, error } = await supabase
      .from("admin_users")
      .insert({ user_id: user.id })
      .select()
      .single();

    if (error) {
      // Check if already exists
      if (error.code === "23505") {
        return { error: "User is already an admin" };
      }
      throw error;
    }

    return { success: true, data };
  });

  app.delete("/admin/users/:userId", { preHandler: requireAdmin }, async (request) => {
    const { userId } = request.params as { userId: string };
    const currentUserId = request.adminUser?.id;

    // Prevent self-deletion
    if (userId === currentUserId) {
      return { error: "Cannot remove yourself" };
    }

    const { error } = await supabase
      .from("admin_users")
      .delete()
      .eq("user_id", userId);

    if (error) {
      throw error;
    }

    return { success: true };
  });

  return app;
}