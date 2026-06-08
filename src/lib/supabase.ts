import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// Browser/SSR client — anon key, fully subject to RLS. Safe to use anywhere.
export function supabasePublic() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
}

// Admin client — service_role key, BYPASSES RLS. SERVER ONLY.
// Importing this anywhere that ships to the browser leaks full DB access.
let _admin: SupabaseClient<Database> | null = null;
export function supabaseAdmin() {
  if (typeof window !== "undefined") {
    throw new Error("supabaseAdmin() must never run in the browser");
  }
  if (!_admin) {
    _admin = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!, // server-only secret
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
  return _admin;
}
