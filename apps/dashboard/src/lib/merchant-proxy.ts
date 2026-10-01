const uuid = "[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}";
const mutation = new RegExp(`^visits/${uuid}/(verify|reject)$`);
const headers = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
};
const errorResponse = (status: number, message: string) =>
  Response.json({ message }, { status, headers });

// Fixed, server-configured upstream. Only the four merchant operations are exposed.
export async function merchantProxy(
  request: Request,
  path: string[],
  apiUrl: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const endpoint = path.join("/");
  if (!(
    (request.method === "GET" && ["locations", "visits"].includes(endpoint)) ||
    (request.method === "POST" && mutation.test(endpoint))
  )) {
    return errorResponse(404, "Ruta no disponible.");
  }
  const auth = request.headers.get("authorization");
  if (
    !auth ||
    auth.length > 8200 ||
    !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(auth)
  )
    return errorResponse(401, "Iniciá sesión nuevamente.");
  const query = new URL(request.url).searchParams;
  const allowed =
    request.method === "GET" && endpoint === "visits"
      ? ["locationId", "status", "limit", "cursor"]
      : [];
  for (const key of query.keys()) {
    if (!allowed.includes(key) || query.getAll(key).length !== 1)
      return errorResponse(400, "Filtro no permitido.");
  }
  let base: URL;
  try {
    base = new URL(apiUrl ?? "");
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/"
    )
      throw new Error();
  } catch {
    return errorResponse(503, "La conexión con la API no está configurada.");
  }
  let body: string | undefined;
  if (request.method === "POST") {
    if (!request.headers.get("content-type")?.includes("application/json"))
      return errorResponse(415, "Usá JSON.");
    // Stream limit also covers requests without Content-Length.
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 4096) {
          await reader.cancel();
          return errorResponse(413, "La solicitud es demasiado grande.");
        }
        chunks.push(next.value);
      }
    }
    body = Buffer.concat(chunks).toString("utf8") || "{}";
    try {
      JSON.parse(body);
    } catch {
      return errorResponse(400, "El JSON no es válido.");
    }
  }
  const url = new URL(`/merchant/${endpoint}`, base);
  url.search = query.toString();
  try {
    const response = await fetcher(url, {
      method: request.method,
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.headers.get("content-type")?.includes("application/json"))
      return errorResponse(502, "La API devolvió una respuesta inesperada.");
    const data: unknown = await response.json();
    return Response.json(data, { status: response.status, headers });
  } catch {
    return errorResponse(
      503,
      "No pudimos conectar con la API. Revisá que esté encendida y reintentá.",
    );
  }
}
