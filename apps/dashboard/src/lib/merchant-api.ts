export interface Location {
  id: string;
  name: string;
  restaurant: { id: string; name: string };
  canReview: boolean;
}
export interface MerchantVisit {
  id: string;
  source: string;
  status: string;
  checkedInAt: string;
  verifiedAt: string | null;
  rejectedReason: string | null;
  location: {
    id: string;
    name: string;
    restaurant: { id: string; name: string };
  };
  user: { displayName: string };
}
export interface VisitPage {
  items: MerchantVisit[];
  nextCursor: string | null;
}
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export async function merchantRequest<T>(
  token: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/merchant/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal,
    });
  } catch {
    throw new ApiError(
      0,
      "No pudimos confirmar la respuesta. Reintentá la misma operación.",
    );
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data &&
      typeof data === "object" &&
      "message" in data &&
      typeof data.message === "string"
        ? data.message
        : "No se pudo completar la operación.";
    throw new ApiError(response.status, message);
  }
  if (!data) throw new ApiError(0, "La respuesta de la API no es válida.");
  return data as T;
}
