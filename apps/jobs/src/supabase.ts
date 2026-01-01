import { createClient } from "@supabase/supabase-js";
import type { Config } from "./config";

export function buildSupabaseClient(config: Config) {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
