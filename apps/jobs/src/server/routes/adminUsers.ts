import type { FastifyInstance } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";

type Deps = {
  supabase: SupabaseClient;
  requireAdmin: (request: unknown, reply: unknown) => Promise<void> | void;
};

export function registerAdminUserRoutes(app: FastifyInstance, deps: Deps) {
  app.get("/admin/users", { preHandler: deps.requireAdmin }, async () => {
    const { data, error } = await deps.supabase
      .from("admin_users")
      .select(`
        user_id,
        created_at
      `)
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    const { data: userList, error: userError } = await deps.supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000
    });

    if (userError) {
      throw userError;
    }

    const userMap = new Map(userList.users.map((user) => [user.id, user]));

    return {
      rows: data.map((row: any) => {
        const user = userMap.get(row.user_id);
        const identities =
          user?.identities?.map((identity: any) => ({
            id: identity.id,
            provider: identity.provider,
            identity_data: identity.identity_data ?? null,
            user_id: identity.user_id
          })) ?? [];

        return {
          user_id: row.user_id,
          created_at: row.created_at,
          email: user?.email ?? null,
          user_created_at: user?.created_at ?? null,
          last_sign_in_at: user?.last_sign_in_at ?? null,
          confirmed_at: user?.confirmed_at ?? null,
          email_confirmed_at: user?.email_confirmed_at ?? null,
          phone: user?.phone ?? null,
          phone_confirmed_at: user?.phone_confirmed_at ?? null,
          role: user?.role ?? null,
          aud: user?.aud ?? null,
          app_metadata: user?.app_metadata ?? null,
          user_metadata: user?.user_metadata ?? null,
          identities
        };
      })
    };
  });

  app.post("/admin/users", { preHandler: deps.requireAdmin }, async (request) => {
    const body = request.body as { email: string; password?: string; createIfNotExists?: boolean };
    if (!body.email) {
      return { error: "email is required" };
    }

    const { data: users, error: userError } = await deps.supabase.auth.admin.listUsers();
    if (userError) {
      throw userError;
    }

    let user = users.users.find((u) => u.email?.toLowerCase() === body.email.toLowerCase());

    if (!user && body.createIfNotExists && body.password) {
      const { data: newUser, error: createError } = await deps.supabase.auth.admin.createUser({
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

    const { data, error } = await deps.supabase
      .from("admin_users")
      .insert({ user_id: user.id })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return { error: "User is already an admin" };
      }
      throw error;
    }

    return { success: true, data };
  });

  app.delete("/admin/users/:userId", { preHandler: deps.requireAdmin }, async (request) => {
    const { userId } = request.params as { userId: string };
    const currentUserId = request.adminUser?.id;

    if (userId === currentUserId) {
      return { error: "Cannot remove yourself" };
    }

    const { error } = await deps.supabase
      .from("admin_users")
      .delete()
      .eq("user_id", userId);

    if (error) {
      throw error;
    }

    return { success: true };
  });
}
