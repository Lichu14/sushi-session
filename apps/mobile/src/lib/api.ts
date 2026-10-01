import { fetch } from 'expo/fetch';
import { createApiClient } from '@/core/api-client';
import { createSushiApi } from '@/core/sushi-api';
import { getConfig } from './config';
import { getSupabase } from './supabase';
export function getApi() {
  return createSushiApi(
    createApiClient(getConfig().apiUrl, getSupabase().auth, fetch),
  );
}
