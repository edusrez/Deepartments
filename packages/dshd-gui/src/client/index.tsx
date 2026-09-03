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
 *
 * dshd-gui phase: this file MOVED verbatim from the bundle
 * (src/client/index.tsx → packages/dshd-gui/src/client/index.tsx).
 * D5 (modularization, 2026-08-29): dshd-gui is the OWNER of the
 * `deepartments-client` surface — its own build:client (package tsdown +
 * packages/dshd-gui/scripts/normalize-client-banner.mjs) produces
 * packages/dshd-gui/client/client.js, and the bundle's root ./client/client.js
 * is a byte-identical MIRROR of it (root build:client = `pnpm --filter
 * dshd-gui run build:client && node scripts/mirror-client.mjs` — R6
 * preserve-the-mirror). The wire contract and the module surface are
 * unchanged.
 *
 * CLIENT-ROW RULE (fix 2026-08-29): the module id registered by this envelope
 * is `dsh-deepartments` (the deepartments-client identity), and the
 * client-modules host keys each graph row by the LOADER ENTRY name — a bundle
 * must register the exact row id. The `dsh.client` row therefore belongs to
 * the dsh-deepartments BUNDLE entry; dshd-gui (entry name `dshd-gui`) must
 * NOT declare `dsh.client`, or the GUI boot fails with
 * `loaded without registering` (Failed to load plugins).
 */

import { useEffect, useState, type CSSProperties } from "react";

export const name = "deepartments-client";
/** `locale` added for the i18n header action + agenda view tab (F4 client UI);
 * the rest is the pre-existing U1/U3 surface. */
export const inject = ["slots", "sessions", "workspaces", "connection", "locale"];

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

// #region F4 client UI (presence toggle + agenda view)
//
// The client UI mirrors two additive DSH slots — `conversation.session.header.utilities`
// (one header button) and `conversation.view` (one session view-ring tab; precedent:
// dsh-client-ui-trajectory). Both are list slots, and the registrant is self-sufficient:
// everything a control needs comes from the registrant's own inject face (`connection`
// RPC + `locale`) plus local React state. The server endpoints (`presence/get`,
// `presence/set`, `agenda/list`) are added by the server builder in src/invoke.ts
// (Builder 2) — this file only consumes them.
//
// The presence toggle is registered in the RIGHT-ALIGNED `header.utilities` slot (not
// the title-adjacent `header.actions` slot, where it previously sat at order 15 and the
// owner observed it beside the title breadcrumb rather than the Session log) so it
// renders beside the native "Session log" download button — that button registers
// `id: 'session-log-download'` in the SAME slot with NO explicit order (defaults to 0).
// The slot orders entries by ascending `order` (default `?? 0`), so our order must be
// > 0 to land immediately to the RIGHT of Session log; 15 is the only other entry, so
// it renders directly adjacent.

/** Value returned by `/deepartments presence/get`. */
export interface PresenceValue {
  present: boolean;
}

// #region Monitor mode — owner presence ↔ composer visibility (GLOBAL)
//
// Owner decision (closed — do NOT reopen): when the EXISTING presence toggle
// («Toggle owner presence», header utilities — PresenceToggle below) switches
// to ABSENT, the composer (text box) is HIDDEN GLOBALLY (every session/tab of
// the GUI, incl. the hero with no open session); switching back to PRESENT
// shows it again. Mode = the OWNER's presence (presence.json `present:false`);
// no new GUI state/toggle. Mechanism (FASE 0 seam, explore-deep report
// 2026-09-03): a body class toggles ONE injected global <style> whose rule
// hides every harness composer seat `[data-composer-seat]` (ui-conversation
// lib/client.js:7266-7271 wraps the whole input stack — composer bar + hero +
// approval — in ALL phases/sessions). LIMIT (owner decision): solo-UI /
// affordance — session.prompt stays callable; the header toggle remains
// visible and explains the state. Server-side enforcement = documented
// POSTERIOR hardening (NOT implemented here; 0 server changes in this lane).
// Global <style>-injection precedent: the pre-U1 client's SETTINGS_STYLE_ID
// (document.createElement("style") + head.appendChild, git ff9e2c4^).

/** Id of the <style> element injected once by apply() (removed on dispose). */
export const MONITOR_STYLE_ID = "dsw-deepartments-monitor-style";
/** Body class toggled while the owner is ABSENT (the style rule is scoped to
 * it, so present → no class → composer visible). */
export const MONITOR_BODY_CLASS = "dsw-deepartments-monitor";
/** The injected CSS rule: with the monitor body class set, EVERY
 * `[data-composer-seat]` is REALLY hidden (display:none — no empty slot, no
 * disabled input; the text is never shown, the layout collapses). */
export const MONITOR_CSS =
  "." + MONITOR_BODY_CLASS + " [data-composer-seat] { display: none !important; }";

/** PURE rule (unit-tested): the monitor body class applies ONLY while the
 * owner is ABSENT (present === false); present → visible (no class). */
export function shouldApplyMonitorMode(present: boolean): boolean {
  return present === false;
}
// #endregion

/** One scheduled job row in the agenda (mirrors dept_job_list frontmatter).
 * `role`/`description` are extras the server forwards (src/invoke.ts readAgendaJobs)
 * and feed the muted row meta line; `next` is the next cron fire as an ISO
 * datetime, rendered as the mono/muted right value. */
export interface AgendaJob {
  id: string;
  title: string;
  role?: string;
  description?: string;
  schedule?: string;
  next?: string;
}

/** One arbitrary calendar entry in the agenda (from `.deepartments/calendar.json`).
 * `jobId` (optional) links the entry to a scheduled job → renders a compact badge. */
export interface AgendaCalendarEntry {
  label: string;
  time: string;
  jobId?: string;
}

/** Value returned by `/deepartments agenda/list`. */
export interface AgendaValue {
  jobs: AgendaJob[];
  calendar: AgendaCalendarEntry[];
}

/** Format a cron next-fire ISO into a compact, locale-neutral `MM-DD HH:mm`
 * timestamp so the right value reads as a mono run time regardless of the app
 * locale (the workspace clock uses the dictionary, not the browser locale). */
function formatNext(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Bindable i18n function (dictionary lookup with optional `{vars}`). */
export type TFunction = (key: string, vars?: Record<string, unknown>) => string;

/** Namespace for the client dictionary; registered via `ctx.locale.register`. */
export const locale = "deepartments";

/** Client dictionary. DSH web is en/zh; add `es` later if the owner prefers it. */
export const dictionary: Record<string, Record<string, string>> = {
  en: {
    "header.present": "Present",
    "header.absent": "Absent",
    "header.aria.toggle": "Toggle owner presence",
    "view.agenda": "Agenda",
    "agenda.loading": "Loading…",
    "agenda.jobs": "Scheduled",
    "agenda.calendar": "Calendar",
    "agenda.empty": "Nothing scheduled yet.",
    "agenda.error": "Couldn't load the agenda.",
    "agenda.schedule.none": "—",
  },
  zh: {
    "header.present": "在岗",
    "header.absent": "离开",
    "header.aria.toggle": "切换所有者在场状态",
    "view.agenda": "日程",
    "agenda.loading": "加载中…",
    "agenda.jobs": "已排期",
    "agenda.calendar": "日历",
    "agenda.empty": "暂无排期内容。",
    "agenda.error": "无法加载日程。",
    "agenda.schedule.none": "—",
  },
};

/** Stable empty arrays so a view with no agenda keeps a fixed identity. */
export const NO_JOBS: AgendaJob[] = [];
export const NO_CALENDAR: AgendaCalendarEntry[] = [];

/** Shared panel chrome for the agenda view tab (inline styles — the client
 * bundle has no CSS-module pipeline, so the design-system CSS vars are used
 * directly). */
const panelStyle: CSSProperties = {
  padding: "12px 16px",
  overflowY: "auto",
  height: "100%",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: 16,
};
const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
/** Section heading — DSH section/overview-heading language
 * (`--dsw-font-xs-strong-13`, secondary). */
const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--dsw-alias-label-secondary)",
  fontFamily: "var(--dsw-font-family)",
  fontWeight: 500,
  fontSize: 13,
  lineHeight: "20px",
};

/** Reset list for a section body (no bullets, no default padding). */
const listStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
};

/** One agenda row base (workspace projectRow/sessionRow pattern: hoverable
 * flex row, 8px radius, 0-centered, 0 8px padding — a touch taller to seat the
 * two-line job cell). */
const rowBase: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  minWidth: 0,
  padding: "7px 10px",
  borderRadius: 8,
};

/** Bottom separator between rows (border-l1) — applied to every row but the
 * last so the list reads as DSH table rows (trajectory td border-l1). */
const rowSeparator: CSSProperties = {
  borderBottom: "1px solid var(--dsw-alias-border-l1)",
};

/** Job left cell: strong title (primary) over muted role/schedule meta. */
const rowMain: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};
const rowTitleStyle: CSSProperties = {
  color: "var(--dsw-alias-label-primary)",
  fontFamily: "var(--dsw-font-family)",
  fontWeight: 500,
  fontSize: 13,
  lineHeight: "20px",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  overflow: "hidden",
};
const rowMetaStyle: CSSProperties = {
  color: "var(--dsw-alias-label-secondary)",
  fontFamily: "var(--dsw-font-family)",
  fontWeight: 400,
  fontSize: 12,
  lineHeight: "17px",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  overflow: "hidden",
};

/** Right value (job next run) — mono, muted, right-aligned, flex:none. */
const rowValueStyle: CSSProperties = {
  flex: "none",
  color: "var(--dsw-alias-label-tertiary)",
  fontFamily: "var(--ds-font-family-code)",
  fontSize: 12,
  lineHeight: "18px",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

/** Calendar right cell: optional jobId badge boxed beside the muted time. */
const rowRightGroup: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flex: "none",
};

/** Compact badge (calendar jobId) — trajectory kindTag pattern (4px radius,
 * 19px tall, 10px/16px, 650 weight, muted pill fill). */
const badgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 19,
  padding: "0 5px",
  borderRadius: 4,
  border: "1px solid transparent",
  fontSize: 10,
  fontWeight: 650,
  lineHeight: "16px",
  color: "var(--dsw-alias-label-secondary)",
  background: "var(--dsw-alias-bg-module-platform)",
  whiteSpace: "nowrap",
};

/** Calendar label cell (primary, regular) over muted time. */
const calLabelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  color: "var(--dsw-alias-label-primary)",
  fontFamily: "var(--dsw-font-family)",
  fontWeight: 400,
  fontSize: 13,
  lineHeight: "20px",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  overflow: "hidden",
};
const calTimeStyle: CSSProperties = {
  flex: "none",
  color: "var(--dsw-alias-label-tertiary)",
  fontFamily: "var(--dsw-font-family)",
  fontSize: 12,
  lineHeight: "18px",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

/** Centered state surface (loading/empty/error): panel chrome + centered text,
 * with the GUI's muted/tinted token colors. */
const statePanelStyle: CSSProperties = {
  ...panelStyle,
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
};
const stateErrorStyle: CSSProperties = {
  ...statePanelStyle,
  color: "var(--dsw-alias-state-error-primary)",
};

/** Loading spinner ring — a self-contained keyframe (unique name, never
 * collides with a host keyframe) since the bundle has no CSS pipeline. */
const SPIN_KEYFRAMES =
  "@keyframes dsw-deepartments-spin{to{transform:rotate(360deg)}}";
const spinnerStyle: CSSProperties = {
  flex: "none",
  width: 12,
  height: 12,
  borderRadius: "50%",
  border: "1.5px solid var(--dsw-alias-border-l2)",
  borderTopColor: "var(--dsw-alias-state-business-primary)",
  animation: "dsw-deepartments-spin .7s linear infinite",
};

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
  /** `locale` (inject): dictionary registration + namespace binding for `t`. */
  locale: {
    register(namespace: string, dict: Record<string, Record<string, string>>): unknown;
    bind(namespace: string): TFunction;
  };
  /** `slots` (inject): additive slot registration. */
  slots: {
    inject(
      name: string,
      register: () => unknown
    ): unknown;
    register(opts: Record<string, unknown>, component: unknown): unknown;
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

  // #region Monitor mode — owner presence ↔ composer visibility (GLOBAL)
  /** ONE applier of the monitor body class, shared by the 5s presence poll
   * below AND PresenceToggle's immediate apply after a successful
   * presence/set (same bundle/module scope — the toggling tab flips at once,
   * every other tab converges through the poll in ≤5s while focused/visible).
   * DOM-guarded: the vm-test sandbox provides head.appendChild + body.classList
   * (the TEST defines the sandbox, the bundle only consumes document); absent
   * DOM/classList keeps the class inert — the pure rule stays unit-tested. */
  function applyMonitorPresence(present: boolean): void {
    if (typeof document === "undefined") return;
    const classes = document.body?.classList;
    if (!classes) return;
    try {
      classes.toggle(MONITOR_BODY_CLASS, shouldApplyMonitorMode(present));
    } catch {
      // Bare sandbox without a full classList — nothing to toggle.
    }
  }

  // Inject the monitor <style> ONCE through an effect; the cleanup removes it
  // on dispose/desmontar (pattern: pre-U1 SETTINGS_STYLE_ID, git ff9e2c4^).
  // The rule only bites while `.dsw-deepartments-monitor` sits on <body>.
  ctx.effect(
    () => {
      if (typeof document === "undefined") return;
      const style = document.createElement("style");
      style.id = MONITOR_STYLE_ID;
      style.textContent = MONITOR_CSS;
      document.head.appendChild(style);
      return () => {
        if (style.parentNode) style.parentNode.removeChild(style);
      };
    },
    "deepartments-client: monitor-mode style (owner absent hides the composer)"
  );

  // One slim 5s presence poll — the SAME cadence + focus/visibility gating as
  // the U3 host/status watcher above. Seeds on apply (default present →
  // visible); each poll reconciles with the server so ANY tab's toggle (or a
  // presence.json edit) converges here in ≤5s. There is no org→browser push:
  // presence/set only followups the host agent (boot.ts:773-784), invisible to
  // the GUI — the poll is the only cross-tab channel.
  ctx.effect(
    () => {
      let disposed = false;
      const visible = () =>
        typeof document === "undefined" ? true : document.visibilityState !== "hidden";

      const poll = async () => {
        if (!visible()) return;
        try {
          const res = await rpc.call("/deepartments", "presence/get", {});
          if (disposed || !res.ok) return;
          // A missing `present` field degrades to present — never hide the
          // composer on a malformed/partial envelope.
          applyMonitorPresence((res.value as PresenceValue).present !== false);
        } catch {
          // Transient RPC failure — keep the last applied state; the next poll
          // retries.
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
      void poll(); // seed promptly on apply (default present → visible)
      return () => {
        disposed = true;
        window.clearInterval(interval);
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
    "deepartments-client: presence monitor poll (owner present/absent)"
  );
  // #endregion

  // #region F4 — client UI (presence toggle + agenda view)
  // Dictionary + bound `t` for the header action and the view tab.
  ctx.effect(
    () => {
      ctx.locale.register(locale, dictionary);
    },
    "deepartments-client: dictionaries"
  );
  const t = ctx.locale.bind(locale);

  /** One header action: a Present/Absent toggle. Reads `presence/get` on mount,
   * flips optimistically and fires `presence/set` on click (reverting on a hard
   * RPC failure so the UI never shows a state the server did not accept).
   * Self-sufficient — the empty owner share carries everything it needs. */
  function PresenceToggle() {
    const [present, setPresent] = useState<boolean>(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
      let disposed = false;
      rpc.call("/deepartments", "presence/get", {})
        .then((res) => {
          if (disposed || !res.ok) return;
          const present = (res.value as PresenceValue).present === true;
          setPresent(present);
          // Align the monitor body class with the server state at mount (the
          // presence poll seeds around the same time — idempotent either way).
          applyMonitorPresence(present);
        })
        .catch(() => {
          // Endpoint may not be mounted yet (Builder 2) — default to absent.
        });
      return () => {
        disposed = true;
      };
    }, []);

    const toggle = async () => {
      if (busy) return;
      const next = !present;
      setPresent(next); // optimistic
      setBusy(true);
      try {
        const res = await rpc.call("/deepartments", "presence/set", { present: next });
        if (!res.ok) {
          setPresent(!next);
          console.warn("[deepartments] presence/set:", res.error);
        } else {
          // Confirmed by the server → apply the monitor mode IN THIS TAB at
          // once (the 5s presence poll converges every other tab/phase).
          applyMonitorPresence(next);
        }
      } catch (error) {
        setPresent(!next);
        console.warn("[deepartments] presence/set failed:", error);
      } finally {
        setBusy(false);
      }
    };

    const label = present ? t("header.present") : t("header.absent");
    const dotColor = present
      ? "var(--dsw-alias-state-success-primary)"
      : "var(--dsw-alias-label-tertiary)";
    return (
      <button
        type="button"
        onClick={() => void toggle()}
        title={t("header.aria.toggle")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 6px",
          border: 0,
          borderRadius: 6,
          background: "transparent",
          color: present
            ? "var(--dsw-alias-state-success-primary)"
            : "var(--dsw-alias-label-secondary)",
          cursor: "pointer",
          fontSize: 12,
          lineHeight: "18px",
        }}
      >
        <span
          aria-hidden
          style={{
            flex: "none",
            width: 8,
            height: 8,
            borderRadius: 999,
            background: dotColor,
            opacity: busy ? 0.5 : 1,
          }}
        />
        <span>{label}</span>
      </button>
    );
  }

  ctx.slots.inject("conversation.session.header.utilities", () =>
    ctx.slots.register(
      {
        name: "conversation.session.header.utilities",
        id: "presence-toggle",
        order: 15,
        locale,
      },
      PresenceToggle
    )
  );

  /** One session view-ring tab: an "Agenda" panel listing scheduled jobs and
   * calendar entries from `/deepartments agenda/list`, with loading / empty /
   * error states. Self-sufficient (local state, not the session snapshot). */
  function AgendaView() {
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const [data, setData] = useState<AgendaValue>({
      jobs: NO_JOBS,
      calendar: NO_CALENDAR,
    });
    useEffect(() => {
      let disposed = false;
      setStatus("loading");
      rpc.call("/deepartments", "agenda/list", {})
        .then((res) => {
          if (disposed) return;
          if (res.ok) {
            const value = res.value as AgendaValue;
            setData({
              jobs: value?.jobs ?? NO_JOBS,
              calendar: value?.calendar ?? NO_CALENDAR,
            });
            setStatus("ready");
          } else {
            setStatus("error");
          }
        })
        .catch(() => {
          if (!disposed) setStatus("error");
        });
      return () => {
        disposed = true;
      };
    }, []);

    if (status === "loading") {
      return (
        <div
          style={{
            ...statePanelStyle,
            flexDirection: "row",
            color: "var(--dsw-alias-label-secondary)",
          }}
        >
          <style>{SPIN_KEYFRAMES}</style>
          <span aria-hidden style={spinnerStyle} />
          <span>{t("agenda.loading")}</span>
        </div>
      );
    }
    if (status === "error") {
      return <div style={stateErrorStyle}>{t("agenda.error")}</div>;
    }
    if (data.jobs.length === 0 && data.calendar.length === 0) {
      return (
        <div style={{ ...statePanelStyle, color: "var(--dsw-alias-label-tertiary)" }}>
          {t("agenda.empty")}
        </div>
      );
    }
    return (
      <div style={panelStyle}>
        {data.jobs.length > 0 && (
          <section style={sectionStyle}>
            <h3 style={sectionTitleStyle}>{t("agenda.jobs")}</h3>
            <ul style={listStyle}>
              {data.jobs.map((job, index) => (
                <li
                  key={job.id}
                  style={{
                    ...rowBase,
                    ...(index < data.jobs.length - 1 ? rowSeparator : {}),
                  }}
                >
                  <div style={rowMain}>
                    <span style={rowTitleStyle}>{job.title}</span>
                    <span style={rowMetaStyle}>
                      {[job.role, job.schedule].filter(Boolean).join(" · ") ||
                        t("agenda.schedule.none")}
                    </span>
                  </div>
                  {job.next ? (
                    <span style={rowValueStyle}>{formatNext(job.next)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        )}
        {data.calendar.length > 0 && (
          <section style={sectionStyle}>
            <h3 style={sectionTitleStyle}>{t("agenda.calendar")}</h3>
            <ul style={listStyle}>
              {data.calendar.map((entry, index) => (
                <li
                  key={entry.label + index}
                  style={{
                    ...rowBase,
                    ...(index < data.calendar.length - 1 ? rowSeparator : {}),
                  }}
                >
                  <span style={calLabelStyle}>{entry.label}</span>
                  <span style={rowRightGroup}>
                    {entry.jobId ? <span style={badgeStyle}>{entry.jobId}</span> : null}
                    <span style={calTimeStyle}>{entry.time}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  ctx.slots.inject("conversation.view", () =>
    ctx.slots.register(
      {
        name: "conversation.view",
        id: "agenda",
        order: 20,
        locale,
        label: () => t("view.agenda"),
        inject: () => ({}),
      },
      AgendaView
    )
  );
  // #endregion
}