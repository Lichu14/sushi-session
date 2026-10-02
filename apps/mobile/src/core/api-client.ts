export class ApiError extends Error {
  readonly status: number;
  readonly cooldownVisitId?: string;
  constructor(status: number, message: string, cooldownVisitId?: string) {
    super(message);
    this.status = status;
    this.cooldownVisitId = cooldownVisitId;
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : 'No se pudo completar la operación. Reintentá.';
}
type AuthSession = { access_token: string; user: { id: string } };
type AuthResult = {
  data: { session: AuthSession | null };
  error: { status?: number } | null;
};
export interface AuthPort {
  getSession(): Promise<AuthResult>;
  refreshSession(): Promise<AuthResult>;
}
const messages: Record<number, string> = {
  400: 'Los datos o el código no son válidos, o el QR venció o agotó sus usos.',
  401: 'Tu sesión no es válida. Volvé a iniciar sesión.',
  403: 'Tu cuenta no tiene permiso para esta operación.',
  404: 'No se encontró el registro solicitado.',
  409: 'El registro cambió o la operación ya existe.',
  429: 'Demasiados intentos. Esperá un momento antes de reintentar.',
};
export function createApiClient(
  baseUrl: string,
  auth: AuthPort,
  transport: typeof fetch = fetch,
  timeoutMs = 20_000,
) {
  let refreshing: Promise<AuthResult> | undefined;
  const refresh = () => {
    refreshing ??= auth.refreshSession().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
  function valid(result: AuthResult): AuthSession {
    if (result.error)
      throw new ApiError(
        result.error.status === 0 ||
          !result.error.status ||
          result.error.status >= 500
          ? 0
          : 401,
        'No se pudo renovar la sesión. Revisá la conexión o volvé a ingresar.',
      );
    if (!result.data.session) throw new ApiError(401, messages[401]);
    return result.data.session;
  }
  return async function request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    // Callers only supply internal paths. A scanned URL must never become an API destination.
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('://')
    )
      throw new ApiError(400, 'Ruta no válida.');
    const initial = valid(await auth.getSession());
    let token = initial.access_token;
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = valid(await auth.getSession());
      if (current.user.id !== initial.user.id)
        throw new ApiError(401, messages[401]);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await transport(baseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          redirect: 'error',
          cache: 'no-store',
        });
        if (response.status === 401 && attempt === 0) {
          const renewed = valid(await refresh());
          if (renewed.user.id !== initial.user.id)
            throw new ApiError(401, messages[401]);
          token = renewed.access_token;
          continue;
        }
        if (!response.ok) {
          // Only this endpoint's stable code and a validated UUID are used.
          // Never surface arbitrary server messages or sensitive response data.
          let cooldownVisitId: string | undefined;
          if (
            response.status === 409 &&
            path === '/check-ins' &&
            method === 'POST'
          ) {
            const data: unknown = await response.json().catch(() => null);
            if (
              data &&
              typeof data === 'object' &&
              'code' in data &&
              data.code === 'CHECK_IN_COOLDOWN' &&
              'visitId' in data &&
              typeof data.visitId === 'string' &&
              /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(data.visitId)
            ) {
              cooldownVisitId = data.visitId;
            }
          }
          throw new ApiError(
            response.status,
            messages[response.status] ??
              'La API no está disponible. Reintentá en un momento.',
            cooldownVisitId,
          );
        }
        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          0,
          'No pudimos confirmar la respuesta. Revisá la conexión y reintentá.',
        );
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ApiError(401, messages[401]);
  };
}
