import {
  createClient,
  processLock,
  type SupabaseClient,
} from '@supabase/supabase-js';
import { getConfig } from './config';
import { authStorage } from './auth-storage';
let client: SupabaseClient | undefined;
export function getSupabase() {
  if (!client) {
    const config = getConfig();
    client = createClient(config.supabaseUrl, config.publishableKey, {
      auth: {
        storage: authStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        lock: processLock,
      },
    });
  }
  return client;
}
