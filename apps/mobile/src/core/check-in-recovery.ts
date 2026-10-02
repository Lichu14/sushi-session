import type { SushiSession } from './types.ts';

export const CHECK_IN_COOLDOWN_MESSAGE =
  'Ya registraste una visita a esta sucursal. Para registrar otra deben pasar cuatro horas desde tu último check-in. Esto no significa que tu conteo siga abierto.';

export function recentVisitAction(session: SushiSession | null): string {
  if (!session) return 'Iniciar conteo de esta visita';
  if (session.status === 'ACTIVE') return 'Continuar conteo';
  if (session.status === 'COMPLETED') return 'Ver resultado';
  return 'Ver sesión cancelada';
}
