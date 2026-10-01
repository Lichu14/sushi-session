export function getConfig() {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (
    !supabaseUrl ||
    !publishableKey ||
    !apiUrl ||
    publishableKey.includes('REPLACE_ME') ||
    supabaseUrl.includes('YOUR_PROJECT')
  ) {
    throw new Error(
      'Completá apps/mobile/.env usando .env.example y reiniciá Expo.',
    );
  }
  if (!publishableKey.startsWith('sb_publishable_'))
    throw new Error('La app solo admite una publishable key de Supabase.');
  for (const value of [supabaseUrl, apiUrl]) {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        'Las URLs públicas no deben contener credenciales ni parámetros.',
      );
    const local =
      ['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname) ||
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
    if (url.protocol !== 'https:' && !(__DEV__ && local))
      throw new Error('Usá HTTPS; HTTP solo se permite en desarrollo local.');
  }
  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ''),
    publishableKey,
    apiUrl: apiUrl.replace(/\/$/, ''),
  };
}
export function configurationError(): string | null {
  try {
    getConfig();
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'Revisá la configuración pública.';
  }
}
