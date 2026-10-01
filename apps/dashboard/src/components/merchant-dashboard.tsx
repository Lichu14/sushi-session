"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { supabaseBrowser } from "../lib/supabase";
import {
  ApiError,
  merchantRequest,
  type Location,
  type MerchantVisit,
  type VisitPage,
} from "../lib/merchant-api";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "No se pudo completar la operación.";

export function MerchantDashboard() {
  const [session, setSession] = useState<Session | null>();
  const [configurationError, setConfigurationError] = useState("");
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void Promise.resolve()
      .then(() => {
        if (!active) return;
        const client = supabaseBrowser();
        const { data } = client.auth.onAuthStateChange((_event, current) => {
          if (active) setSession(current);
        });
        unsubscribe = () => data.subscription.unsubscribe();
        return client.auth.getSession();
      })
      .then((result) => {
        if (!active || !result) return;
        if (result.error)
          throw new Error("No se pudo recuperar la sesión. Recargá la página.");
        setSession(result.data.session);
      })
      .catch((error) => {
        if (active) setConfigurationError(errorText(error));
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);
  return (
    <main>
      <header>
        <div>
          <h1>Sushi Session</h1>
          <p className="muted">Panel de restaurantes · Revisión de visitas</p>
        </div>
      </header>
      {configurationError ? (
        <p role="alert" className="error">
          {configurationError}
        </p>
      ) : session === undefined ? (
        <p role="status">Cargando sesión…</p>
      ) : session ? (
        <VisitWorkspace key={session.user.id} session={session} />
      ) : (
        <Login />
      )}
    </main>
  );
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await supabaseBrowser().auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (result.error)
        throw new Error(
          "No pudimos iniciar sesión. Revisá email, contraseña y conexión.",
        );
      setPassword("");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h2>Ingresar al restaurante</h2>
      <p>Usá una cuenta con membresía comercial activa.</p>
      <form
        className="login"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Ingresando…" : "Ingresar"}
        </button>
      </form>
    </section>
  );
}

function VisitWorkspace({ session }: { session: Session }) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [status, setStatus] = useState("PENDING");
  const [page, setPage] = useState<VisitPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const generation = useRef(0);
  const mutationPending = useRef(false);

  const request = useCallback(
    async <T,>(
      path: string,
      body?: unknown,
      signal?: AbortSignal,
    ): Promise<T> => {
      const auth = supabaseBrowser().auth;
      const current = await auth.getSession();
      if (current.error || current.data.session?.user.id !== session.user.id)
        throw new ApiError(401, "La sesión cambió. Volvé a ingresar.");
      try {
        return await merchantRequest<T>(
          current.data.session.access_token,
          path,
          body,
          signal,
        );
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status !== 401)
          throw failure;
        const fresh = await auth.refreshSession();
        if (fresh.error || fresh.data.session?.user.id !== session.user.id)
          throw new ApiError(
            401,
            "La sesión venció. Cerrá sesión y volvé a ingresar.",
          );
        return merchantRequest<T>(
          fresh.data.session.access_token,
          path,
          body,
          signal,
        );
      }
    },
    [session.user.id],
  );

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    void Promise.resolve()
      .then(async () => {
        if (controller.signal.aborted) return;
        setLoading(true);
        setError("");
        setPage(null);
        const query = new URLSearchParams({
          status,
          limit: "20",
          ...(locationId ? { locationId } : {}),
        });
        const [allowed, visits] = await Promise.all([
          request<{ items: Location[] }>(
            "locations",
            undefined,
            controller.signal,
          ),
          request<VisitPage>(`visits?${query}`, undefined, controller.signal),
        ]);
        if (current !== generation.current) return;
        setLocations(allowed.items);
        setPage(visits);
      })
      .catch((failure) => {
        if (current === generation.current) {
          setError(errorText(failure));
          setLocations([]);
        }
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => {
      generation.current = current + 1;
      controller.abort();
    };
  }, [request, locationId, status, revision]);

  async function nextPage() {
    if (!page?.nextCursor || loading || busyId) return;
    const current = generation.current;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({
        status,
        limit: "20",
        cursor: page.nextCursor,
        ...(locationId ? { locationId } : {}),
      });
      const result = await request<VisitPage>(`visits?${query}`);
      if (current === generation.current) setPage(result);
    } catch (failure) {
      if (current === generation.current) setError(errorText(failure));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  async function review(
    visit: MerchantVisit,
    decision: "verify" | "reject",
    reason?: string,
  ): Promise<boolean> {
    if (mutationPending.current) return false;
    mutationPending.current = true;
    setBusyId(visit.id);
    setError("");
    setNotice("");
    const current = generation.current;
    try {
      await request<MerchantVisit>(
        `visits/${visit.id}/${decision}`,
        decision === "reject" ? { reason } : {},
      );
      if (current !== generation.current) return false;
      setNotice(
        decision === "verify" ? "Visita confirmada." : "Visita rechazada.",
      );
      setRevision((value) => value + 1);
      return true;
    } catch (failure) {
      if (current === generation.current) {
        setError(errorText(failure));
        // Do not discard the rejection draft after a network failure.
        if (
          failure instanceof ApiError &&
          [403, 404, 409].includes(failure.status)
        ) {
          setPage((previous) =>
            previous
              ? {
                  ...previous,
                  items: previous.items.filter((item) => item.id !== visit.id),
                }
              : null,
          );
        }
      }
      return false;
    } finally {
      mutationPending.current = false;
      setBusyId(null);
    }
  }

  async function logout() {
    if (mutationPending.current) return;
    setSigningOut(true);
    setError("");
    try {
      const result = await supabaseBrowser().auth.signOut({ scope: "local" });
      if (result.error) throw new Error("No se pudo cerrar sesión. Reintentá.");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <>
      <header>
        <p>Sesión: {session.user.email}</p>
        <button
          className="secondary"
          disabled={busyId !== null || signingOut}
          onClick={() => {
            void logout();
          }}
        >
          {signingOut ? "Cerrando…" : "Cerrar sesión"}
        </button>
      </header>
      <section aria-label="Filtros de visitas">
        <h2>Visitas del restaurante</h2>
        <p className="muted">
          La confirmación registra la visita como verificada. No genera premios
          en esta fase.
        </p>
        <div className="toolbar">
          <label>
            Sucursal
            <select
              value={locationId}
              disabled={loading || busyId !== null}
              onChange={(event) => {
                setLocationId(event.target.value);
                setNotice("");
              }}
            >
              <option value="">Todas las sucursales permitidas</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.restaurant.name} · {location.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Estado
            <select
              value={status}
              disabled={loading || busyId !== null}
              onChange={(event) => {
                setStatus(event.target.value);
                setNotice("");
              }}
            >
              <option value="PENDING">Pendientes</option>
              <option value="VERIFIED">Verificadas</option>
              <option value="REJECTED">Rechazadas</option>
              <option value="CANCELLED">Canceladas</option>
            </select>
          </label>
          <button
            className="secondary"
            disabled={loading || busyId !== null}
            onClick={() => setRevision((value) => value + 1)}
          >
            Actualizar listado
          </button>
        </div>
      </section>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {loading && <p role="status">Cargando visitas…</p>}
      {!loading && page?.items.length === 0 && !error && (
        <section>
          <p>
            No hay visitas{" "}
            {status === "PENDING" ? "pendientes" : "con este estado"} para las
            sucursales seleccionadas.
          </p>
        </section>
      )}
      {page?.items.map((visit) => (
        <VisitRow
          key={visit.id}
          visit={visit}
          canReview={locations.some(
            (location) =>
              location.id === visit.location.id && location.canReview,
          )}
          disabled={busyId !== null || loading}
          review={review}
        />
      ))}
      {page && (
        <div className="actions">
          <button
            className="secondary"
            disabled={loading || busyId !== null}
            onClick={() => setRevision((value) => value + 1)}
          >
            Volver al inicio
          </button>
          <button
            disabled={!page.nextCursor || loading || busyId !== null}
            onClick={() => {
              void nextPage();
            }}
          >
            Página siguiente
          </button>
        </div>
      )}
    </>
  );
}

function VisitRow({
  visit,
  canReview,
  disabled,
  review,
}: {
  visit: MerchantVisit;
  canReview: boolean;
  disabled: boolean;
  review: (
    visit: MerchantVisit,
    decision: "verify" | "reject",
    reason?: string,
  ) => Promise<boolean>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <article aria-label={`Visita de ${visit.user.displayName}`}>
      <div className="visit-head">
        <h2>{visit.user.displayName}</h2>
        <span>{visit.status}</span>
      </div>
      <p>
        {visit.location.restaurant.name} · {visit.location.name}
      </p>
      <p>
        Ingreso: {new Date(visit.checkedInAt).toLocaleString("es-AR")} · Origen:{" "}
        {visit.source}
      </p>
      <p className="muted">Visita {visit.id}</p>
      {visit.verifiedAt && (
        <p>Verificada: {new Date(visit.verifiedAt).toLocaleString("es-AR")}</p>
      )}
      {visit.rejectedReason && <p>Motivo: {visit.rejectedReason}</p>}
      {visit.status === "PENDING" &&
        (canReview ? (
          <>
            <div className="actions">
              <button
                disabled={disabled || rejecting}
                onClick={() => {
                  void review(visit, "verify");
                }}
              >
                Confirmar
              </button>
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => setRejecting(true)}
              >
                Rechazar
              </button>
            </div>
            {rejecting && (
              <form
                className="reject-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (reason.trim())
                    void review(visit, "reject", reason.trim());
                }}
              >
                <label>
                  Motivo del rechazo
                  <textarea
                    required
                    maxLength={300}
                    value={reason}
                    disabled={disabled}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <div className="actions">
                  <button type="submit" disabled={disabled || !reason.trim()}>
                    Confirmar rechazo
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    disabled={disabled}
                    onClick={() => setRejecting(false)}
                  >
                    Cancelar
                  </button>
                </div>
              </form>
            )}
          </>
        ) : (
          <p className="muted">
            Tu rol tiene acceso de sólo lectura a esta sucursal.
          </p>
        ))}
    </article>
  );
}
