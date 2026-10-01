import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;
export function supabaseBrowser(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (
    !url ||
    !/^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(url) ||
    !key ||
    !/^sb_publishable_[A-Za-z0-9_-]{16,200}$/.test(key) ||
    key.includes("REPLACE_ME")
  ) {
    throw new Error(
      "Completá la configuración pública del dashboard y reiniciá el servidor.",
    );
  }
  // Auth only, client-side. No business table access. Tokens remain in this tab's
  // sessionStorage; they are not cookies and cannot authorize cross-site form posts.
  client = createClient(url, key, {
    auth: {
      storage: window.sessionStorage,
      storageKey: "sushi-merchant-auth",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}
