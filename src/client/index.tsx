/**
 * dsh-deepartments client plugin.
 *
 * U1 — custom-sidebar removal: the "main agents" sidebar (the workspace-slot
 * shadow with agent/head rows, the injected styles incl. the native New Session
 * CSS patch, the Deepartments settings card and its config gate) has been
 * REMOVED. This module renders NOTHING — the native dsh sidebar
 * (WorkspaceBrowser with its New Session button) is the surface.
 *
 * U3 — host-session-rotation lifecycle watcher (spec 002 §6): a HEADLESS
 * watcher that polls the server `/deepartments` `host/status` RPC on the same
 * 5s cadence + focus/visibility gating the old heartbeat used. When the
 * registered HOST session id CHANGES (U2's dept_sleep rotation retired the old
 * host and created a NEW session server-side), the watcher OPENS the new
 * session (`ctx.sessions.open`) so the owner sees the fresh native "New
 * Session" screen — the native sidebar already hides the archived old row (the
 * pushed `host/archived-sessions-changed` envelope installs it; the client
 * never archives). No shadow, no client-side create/archive.
 *
 * The first observation only SEEDS the baseline WITHOUT opening (the boot may
 * already be inside the host session — never steal the active tab at boot);
 * subsequent id changes trigger the open. A host id absent from the local
 * store forces one `ctx.sessions.refresh()` (the rotated session is COLD
 * server-side — no session-added frame ever reveals it); if it is still
 * absent it logs loudly and re-polls — never client-creates (a client-created
 * id is NOT the registered host — the wake pack would never fire for it).
 *
 * Named exports only (AGENTS.md rule 1); no export default.
 */

export const name = "deepartments-client";
export const inject = ["slots", "sessions", "workspaces", "connection"];

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Mirror of the server's `/deepartments host/status` payload (U3;
 * src/invoke.ts HostStatusPayload). */
export interface HostStatusValue {
  /** The current registered host session id (live hosts.json entry), or null
   * when no host is registered. */
  hostSessionId: string | null;
  /** The live entry's rotation-source session id; null when absent. */
  previousSessionId: string | null;
  /** Retired host entries (informative — the native sidebar already hides
   * archived rows server-side). */
  retired: Array<{ sessionId: string; retiredAt: number }>;
  /** The live host's journal wake_counter, when the server provides it. */
  wakeCounter?: number;
}

/** PURE transition rule (unit-tested): open the server-created host session
 * ONLY when the id CHANGED since the module's first observation.
 *   null→id     seed — first observation, no open (the boot may already be IN
 *               the host session; never steal the active tab)
 *   id→same id  no-op (idempotency — never re-open in a loop)
 *   id→new id   OPEN — a rotation happened (old retired server-side)
 *   id→null     no-op (host unregistered — keep the baseline) */
export function shouldOpenHostSession(previous: string | null, current: string | null): boolean {
  if (current === null) return false;
  if (previous === null) return false;
  return current !== previous;
}

/** PURE refresh trigger (unit-tested): once a rotation transition is detected
 * (shouldOpenHostSession), whether the watcher must force `ctx.sessions.refresh()`.
 * The rotated session is COLD server-side (persistence.create — no agent born),
 * so the host never emits a `host/session-added` frame for it and the local
 * store only learns about it through the `api.sessions.list` RPC: without the
 * forced refresh the open waits for the next connection generation (observed
 * ~2:51 delay). */
export function shouldRefreshForHost(
  previous: string | null,
  current: string | null,
  presentInStore: boolean
): boolean {
  return shouldOpenHostSession(previous, current) && !presentInStore;
}

/** Minimal client root-context surface the watcher relies on (client-runner
 * inject; provided by the base bundles). */
interface ClientCtx {
  effect(fn: () => void | (() => void), label?: string): void;
  sessions: {
    list: {
      getSnapshot(): { ids?: string[]; current?: string };
    };
    open(id: string): unknown;
    /** Force the api.sessions.list baseline pull (real SessionRuntime.refresh,
     * single-flight); the U3 gate uses it to reveal a COLD rotated host session. */
    refresh(): unknown;
  };
  connection: {
    rpc: {
      call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>>;
    };
  };
}

export function apply(ctx: ClientCtx): void {
  const rpc = ctx.connection.rpc;
  // Module-scoped baseline (survives effect re-runs): the last observed host
  // session id. First observation seeds it WITHOUT opening; a later CHANGE to
  // a different non-null id triggers the open.
  let lastHostSessionId: string | null = null;

  // ONE slim 5s poll owns the host-status cadence (mirror of the removed
  // heartbeat: setInterval + focus/visibility gating, torn down with the
  // effect). The watcher is headless: no rendering, no slots, no styles.
  ctx.effect(
    () => {
      let disposed = false;
      const visible = () =>
        typeof document === "undefined" ? true : document.visibilityState !== "hidden";

      const poll = async () => {
        if (!visible()) return;
        let current: string | null = null;
        try {
          const res = await rpc.call("/deepartments", "host/status", {});
          if (disposed || !res.ok) return;
          current = (res.value as HostStatusValue).hostSessionId ?? null;
        } catch {
          // Transient RPC failure — keep last data; the next poll retries.
          return;
        }
        if (disposed || current === null) return;
        if (!shouldOpenHostSession(lastHostSessionId, current)) {
          // Seed the baseline (first observation) or same-id no-op.
          lastHostSessionId = current;
          return;
        }
        // Transition to a DIFFERENT non-null id → open the server-created
        // session. NEVER client-create: a client-created id is not the
        // registered host (the wake pack would never fire for that tab).
        if (
          shouldRefreshForHost(
            lastHostSessionId,
            current,
            (ctx.sessions.list.getSnapshot().ids ?? []).includes(current)
          )
        ) {
          // The rotated host session is COLD server-side (persistence.create —
          // no agent born → no host/session-added frame will ever reveal it):
          // force the api.sessions.list pull NOW instead of waiting for a
          // connection generation to refresh the store (observed ~2:51 delay).
          await ctx.sessions.refresh();
        }
        if (!(ctx.sessions.list.getSnapshot().ids ?? []).includes(current)) {
          console.warn(
            "[deepartments] host/status: new host session " + current +
            " not in the local session store yet — re-polling (no client-side create)"
          );
          return; // keep the baseline — the next poll re-attempts
        }
        lastHostSessionId = current; // idempotent: never re-open in a loop
        try {
          ctx.sessions.open(current);
        } catch (error) {
          console.warn("[deepartments] host/status: open failed for", current, error);
        }
      };

      const run = () => void poll();
      const interval = window.setInterval(run, 5000);
      const onFocus = () => run();
      const onVisibility = () => {
        if (visible()) run();
      };
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVisibility);
      void poll(); // seed the baseline promptly on apply
      return () => {
        disposed = true;
        window.clearInterval(interval);
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
    "deepartments-client: host/status lifecycle watcher"
  );
}