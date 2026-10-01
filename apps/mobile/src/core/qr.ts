const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
export function parseCheckInQr(raw: string): {
  locationId: string;
  token: string;
} {
  try {
    if (raw.length > 12_000) throw new Error();
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error();
    const item = data as Record<string, unknown>;
    if (
      item.v !== 1 ||
      Object.keys(item).some(
        (k) => !['v', 'locationId', 'token'].includes(k),
      ) ||
      typeof item.locationId !== 'string' ||
      !uuid.test(item.locationId) ||
      typeof item.token !== 'string' ||
      !item.token.trim() ||
      item.token.length > 2048
    )
      throw new Error();
    return { locationId: item.locationId.toLowerCase(), token: item.token };
  } catch {
    throw new Error(
      'Este QR no tiene el formato de Sushi Session. Pedí el código de la sucursal.',
    );
  }
}
