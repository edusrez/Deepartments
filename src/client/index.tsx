import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { StateDot } from "@deepseek-ai/dsh-client-ui-primitives";

/**
 * dsh-deepartments client plugin.
 *
 * Replaces the left sidebar "workspaces" region with a list of "main agents":
 * the host row (first) plus department heads served by the host RPC
 * channel `/deepartments` endpoint `agents`. Hides the New Session button and
 * stays fully reversible (every registration/effect is torn down via the
 * cordis `ctx.effect` disposer).
 *
 * Batch 1a/1b: department heads are FIRST-CLASS ROOT AGENTS (session id
 * `head-<postId>`, origin undefined), so they also appear in the native
 * sessions snapshot. This shadow keeps its custom chrome/status dots as the
 * single roster source and EXCLUDES `head-*` sessions from the Assistant rows
 * (see isAssistant) so each head renders exactly once.
 *
 * A "Deepartments" tab in the DSH Settings UI exposes a two-option segment
 * selector (Enabled/Disabled) that toggles the sidebar shadow + injected
 * `<style>`, persisted via the `/deepartments` RPC (`ui/config/set`) to
 * `<stateDir>/ui.json`. The section is registered unconditionally so the tab
 * always exists; the sidebar mount is gated LIVE on `sidebarEnabled`,
 * reconciled by a 5s RPC poll — toggling the selector mounts/unmounts it with
 * no refresh, from any origin (Tailscale + loopback).
 *
 * Named exports only (AGENTS.md rule 1); no export default.
 */

export const name = "deepartments-client";
export const inject = ["slots", "sessions", "workspaces", "connection"];

// ---------------------------------------------------------------------------
// RPC data shapes (mirror the server's /deepartments 'agents' endpoint)
// ---------------------------------------------------------------------------
type HeadStatus = "working" | "completed-notice" | "idle" | "sleeping";

interface AgentHead {
  id: string;
  name: string;
  department?: string;
  kind: "host" | "post";
  status: HeadStatus;
  unread: number;
  running: boolean;
  sleeping: boolean;
  /** Live signal: the head's stable root-agent session is present in the
   * agents registry (Batch 1b — replaced the legacy `parentLive`; heads are
   * root agents with no parent, so there is no parent-liveness anymore). */
  sessionLive: boolean;
}

interface AgentsValue {
  host: { id: string; name: string; department?: string };
  agents: AgentHead[];
}

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

// ---------------------------------------------------------------------------
// Mini external store for the UI config (`sidebarEnabled`), shared by the live
// sidebar gate and the settings section selector. The gate polls the
// `/deepartments` `ui/config` RPC on an interval + window focus and pushes the
// value here; the section publishes optimistic writes here before persisting.
// ---------------------------------------------------------------------------
const uiStore = (() => {
  let value = { sidebarEnabled: true };
  const listeners = new Set<(v: { sidebarEnabled: boolean }) => void>();
  return {
    get: () => value,
    set: (v: { sidebarEnabled: boolean }) => { value = v; for (const l of listeners) l(value); },
    subscribe: (fn: (v: { sidebarEnabled: boolean }) => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
})();

// Minimal client root-context surface we rely on (provided by base bundles).
interface ClientCtx {
  effect(fn: () => void | (() => void), label?: string): void;
  slots: {
    register(
      options: {
        name: string;
        priority?: number;
        id?: string;
        order?: number;
        label?: string | (() => string);
        inject?: () => Record<string, unknown>;
      },
      component: (props: any) => ReactNode
    ): (() => void) | void;
  };
  sessions: {
    list: {
      getSnapshot(): {
        current: string | undefined;
        byId?: Record<string, any>;
        ids?: string[];
      };
    };
    open(id: string): unknown;
  };
  workspaces: {
    startSession(workspaceId?: string): unknown;
    archiveSession(sessionId: string): Promise<void>;
  };
  connection: {
    rpc: {
      call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>>;
    };
  };
}

// Injected owner face received by AgentList.
interface AgentsOwner {
  wide: boolean;
  expandSidebar: () => void;
  openSession: (id: string) => void;
  currentSessionId: () => string | undefined;
  /** Full sessions list snapshot (SessionListState): for the multi-Assistant rows. */
  sessionSnapshot: () => any;
  startSession: () => void;
  rpc: ClientCtx["connection"]["rpc"];
  /** Archive a session (stopping it and its subagents); removed from the list. */
  archiveSession: (id: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Styles (plain `dp-` prefixed classes + the New Session hiding rule).
// ---------------------------------------------------------------------------
const AGENT_CSS = /* css */ `
/* ---- New Session button: hide only the actual New Session button ---- */
/* NOTE: do NOT hide by aria-label here. In the native sidebar both the brand
   button (logo) and the New Session button carry aria-label "New session",
   so an aria-label rule would hide the brand logo too. Target ONLY the
   hashed class applied to the New Session button itself. */
.hHd-Xa_newSession{display:none}
/* ---------------------------------------------------------------------------- */

/* ---- main agents list ---- */
.dp-agents-heading{
  margin:0 0 6px;
  padding:0 12px;
  font-size:11px;
  font-weight:600;
  letter-spacing:.04em;
  text-transform:uppercase;
  color:var(--dsw-alias-label-caption);
}
.dp-agents-list{display:flex;flex-direction:column;gap:6px;padding:0 8px;}
.dp-agent-row{
  position:relative;
  display:flex;align-items:center;gap:8px;
  padding:6px 8px;border-radius:8px;
  background:transparent;border:none;font:inherit;
  color:var(--dsw-alias-label-secondary);
  text-align:left;
  cursor:pointer;user-select:none;width:100%;box-sizing:border-box;
}
.dp-agent-row:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dp-agent-row--static{cursor:default;}
.dp-agent-row--static:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dp-agent-row--active{background:var(--dsw-alias-interactive-bg-hover,#eef0f4);}
/* main open-area button inside an assistant row (transparent, fills the row) */
.dp-agent-open{
  flex:1;min-width:0;display:flex;align-items:center;gap:8px;
  padding:0;background:transparent;border:none;font:inherit;
  color:inherit;text-align:left;
  cursor:pointer;user-select:none;box-sizing:border-box;
}
.dp-agent-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-primary);}

/* trailing ⋯ menu button — visible on row hover or while the menu is open */
.dp-agent-menu-btn{
  flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:22px;height:22px;border-radius:6px;margin-right:2px;
  background:transparent;border:none;font:inherit;font-size:15px;line-height:1;
  color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;
  opacity:0;transition:opacity .12s ease;
}
.dp-agent-menu-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#eef0f4);}
.dp-agent-menu-btn:focus-visible{opacity:1;}
.dp-agent-row:hover .dp-agent-menu-btn,
.dp-agent-row--menu-open .dp-agent-menu-btn{opacity:1;}

/* ⋯ dropdown */
.dp-agent-menu{
  position:absolute;right:8px;top:calc(100% + 4px);z-index:50;
  min-width:140px;padding:4px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-1,#fff);
  border:1px solid var(--dsw-alias-border-l2,#e5e7eb);
  box-shadow:0 4px 16px #0000001a;
}
.dp-agent-menu button{
  display:block;width:100%;padding:6px 10px;border:none;border-radius:6px;
  background:transparent;font:inherit;font-size:13px;text-align:left;
  color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;user-select:none;
}
.dp-agent-menu button:hover{background:var(--dsw-alias-interactive-bg-hover,#eef0f4);}

/* status glyphs */
.dp-dot{display:inline-flex;align-items:center;justify-content:center;width:10px;height:10px;flex:none;}
.dp-dot[data-state="idle"]{width:8px;height:8px;border-radius:50%;background:#9ca3af;}
.dp-moon{display:inline-block;width:10px;height:10px;flex:none;}

/* collapsed mode: compact vertical dot stack, no labels */
.dp-agents-collapsed{display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 0;}
.dp-agents-collapsed .dp-dot{width:8px;height:8px;border-radius:50%;background:#9ca3af;}
.dp-agents-collapsed .dp-dot[data-state="idle"]{background:#9ca3af;}
.dp-agents-collapsed .dp-moon{width:8px;height:8px;}
.dp-agents-collapsed .dp-dot[data-state="done"],.dp-agents-collapsed .dp-dot[data-state="warning"],.dp-agents-collapsed .dp-dot[data-state="ongoing"]{background:var(--dsw-alias-state-success-primary);}

/* ---- New session button ---- */
.dp-new-session-btn{
  display:flex;align-items:center;justify-content:center;gap:6px;
  width:calc(100% - 16px);margin:0 8px 12px;
  padding:8px 12px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2,#e5e7eb);
  background:var(--dsw-alias-bg-layer-1,#fff);
  font:inherit;font-size:13px;font-weight:500;
  color:var(--dsw-alias-label-primary,#1f2328);
  cursor:pointer;user-select:none;box-sizing:border-box;
}
.dp-new-session-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#eef0f4);}
.dp-new-session-btn:active{background:var(--dsw-alias-bg-layer-2,#f2f3f5);}
`;

// Settings section + segment selector styles. Kept OUT of AGENT_CSS because
// AGENT_CSS is gated by the sidebar toggle: the toggle itself must render even
// when the sidebar is off, so this style is injected unconditionally with the
// section.
const SETTINGS_CSS = /* css */ `
/* settings section card */
.dp-settings-card{
  display:flex;flex-direction:column;gap:16px;
  padding:16px 18px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);
  border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);
}
.dp-settings-head{display:flex;align-items:center;gap:16px;}
.dp-settings-labelbox{display:flex;flex-direction:column;flex:1;min-width:0;gap:4px;}
.dp-settings-label{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#1f2328);}
.dp-settings-hint{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8b93a1);}

/* two-option segment selector (mirrors the DSH settings options style) */
.dp-settings-select{
  display:flex;flex-direction:row;gap:4px;flex:none;
  padding:3px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-2,#f2f3f5);
}
.dp-settings-option{
  flex:none;padding:5px 12px;border-radius:6px;
  background:transparent;border:1px solid transparent;
  font:inherit;font-size:13px;font-weight:500;line-height:1.2;
  color:var(--dsw-alias-label-secondary,#5b6472);
  cursor:pointer;user-select:none;
}
.dp-settings-option:hover{background:var(--dsw-alias-interactive-bg-hover,#eef0f4);}
.dp-settings-option--active{
  background:var(--dsw-alias-bg-layer-1,#fff);
  border-color:var(--dsw-alias-border-l2,#e5e7eb);
  color:var(--dsw-alias-label-primary,#1f2328);
  box-shadow:0 1px 2px #00000014;
}
.dp-settings-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px;}
`;

// ---------------------------------------------------------------------------
// Helpers (pure, render-safe).
// ---------------------------------------------------------------------------
function asistenteStatus(node: any): "done" | "warning" | "ongoing" {
  if (node === undefined || node === null) return "done";
  if (node.pendingInteraction) return "warning";
  if (node.running || (node.runningSubagentCount ?? 0) > 0) return "ongoing";
  return "done";
}

const HEAD_TITLES: Record<HeadStatus, string> = {
  working: "Working",
  "completed-notice": "Completed notification",
  idle: "Idle",
  sleeping: "Sleeping"
};

// Stable session-id prefix of the first-class ROOT-AGENT department heads
// (server: HeadSessionId = `head-<postId>`, Batch 1a/1b). Since a head is a
// non-subagent root agent, it now appears in the NATIVE sessions snapshot too
// (origin absent → `isAssistant` would otherwise list it). We exclude these
// ids from the Assistant rows so a head is rendered exactly ONCE — by the RPC
// `heads` list below (which carries the richer custom status dots) — and not
// double-listed as an "Assistant" row as well. Mirrors the deploy contract the
// server persists; the roster source is the `/deepartments` RPC, not the
// native tree.
const HEAD_SESSION_PREFIX = "head-";

function HeadStatusDot({ status }: { status: HeadStatus }) {
  const title = HEAD_TITLES[status] ?? "";
  if (status === "working") {
    return (
      <span className="dp-dot" title={title} aria-hidden="true">
        <StateDot state="ongoing" size={10} />
      </span>
    );
  }
  if (status === "completed-notice") {
    return (
      <span className="dp-dot" title={title} aria-hidden="true">
        <StateDot state="done" size={10} />
      </span>
    );
  }
  if (status === "sleeping") {
    return (
      <svg
        className="dp-moon"
        viewBox="0 0 16 16"
        width="10"
        height="10"
        aria-hidden="true"
        role="img"
      >
        <title>{title}</title>
        <path
          d="M13.6 9.7A6 6 0 0 1 6.3 2.4 6 6 0 1 0 13.6 9.7Z"
          fill="#9ca3af"
        />
      </svg>
    );
  }
  // idle: static gray dot.
  return (
    <span className="dp-dot" data-state="idle" title={title} aria-hidden="true" />
  );
}

// ---------------------------------------------------------------------------
// AgentList — renders the main agents into the sidebar.workspaces hole.
// ---------------------------------------------------------------------------
export function AgentList(props: AgentsOwner) {
  const { wide, expandSidebar, openSession, currentSessionId, sessionSnapshot, startSession, rpc, archiveSession } = props;
  const [host, setHost] = useState<AgentsValue["host"] | null>(null);
  const [heads, setHeads] = useState<AgentHead[]>([]);
  const [snapshot, setSnapshot] = useState(() => sessionSnapshot());
  // Session ids archived via workspace.archiveSession (still present in the
  // sessions snapshot but should not appear as Assistant rows).
  const [archivedSet, setArchivedSet] = useState<Set<string>>(new Set());
  // Which Assistant row has its ⋯ (archive) menu open.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;

    const fetchAgents = async () => {
      const sid = currentSessionId();
      const res = await rpc.call("/deepartments", "agents", { sessionId: sid ?? undefined });
      if (disposed) return;
      if (res.ok) {
        const value = res.value as AgentsValue;
        setHost(value.host);
        setHeads(Array.isArray(value.agents) ? value.agents : []);
      }
      // On { ok: false } keep last data; the next poll retries silently.
    };

    const refreshSessions = () => {
      if (!disposed) setSnapshot(sessionSnapshot());
    };

    // Fetch archived session ids via the injected trusted-host RPC transport
    // (ctx.connection.rpc) — the same rpc.call path used for agents/config
    // above, not a raw fetch. The response envelopes { result.intent, value }
    // where value.archivedSessionIds is top-level only. Non-blocking: on
    // failure keep the last known set.
    const fetchArchived = async () => {
      try {
        const res = await rpc.call("/api", "workspace.list", {});
        if (!res.ok) return;
        const value = res.value as any;
        const archived: string[] = Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds : [];
        const next = new Set<string>(archived);
        setArchivedSet((prev) =>
          next.size !== prev.size || [...next].some((id) => !prev.has(id)) ? next : prev
        );
      } catch {
        // Keep last set; the next poll retries silently.
      }
    };

    fetchAgents();
    refreshSessions();
    fetchArchived();
    const interval = window.setInterval(() => {
      fetchAgents();
      refreshSessions();
      fetchArchived();
    }, 5000);
    const onFocus = () => {
      fetchAgents();
      refreshSessions();
      fetchArchived();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Assistant rows = non-blank, non-archived host-origin sessions in host-list
  // creation order. Filters:
  //  - !s.blank   : server `blank` bit — "only show after the first message"
  //                 (a session disappears until it has content).
  //  - origin     : hide subagent child sessions (origin === 'subagent');
  //                 hosts carry no origin (undefined → kept). This hides the
  //                 builder/subagent children that are not Assistants.
  //  - not-head   : hide the first-class department-head sessions
  //                 (id `head-<postId>`), which are ALSO non-subagent root
  //                 agents in the snapshot — they are rendered once by the RPC
  //                 `heads` list (custom status dots), so excluding them here
  //                 prevents a duplicate "Assistant" row (Batch 1b).
  //  - archived   : hide session ids in `archivedSet` (from workspace.list),
  //                 i.e. old Assistants archived via workspace.archiveSession.
  const byId = (snapshot && snapshot.byId) || {};
  const ids = snapshot && snapshot.ids;
  const isAssistant = (s: any) =>
    !!(
      s &&
      !s.blank &&
      s.origin !== "subagent" &&
      !(s.id || s.sessionId || "").startsWith(HEAD_SESSION_PREFIX) &&
      !archivedSet.has(s.id || s.sessionId)
    );
  let assistantRows: any[] = ids && ids.length
    ? ids.map((id: string) => byId[id]).filter(isAssistant)
    : Object.values(byId).filter(isAssistant);
  // Creation order, oldest first: the snapshot `ids` list is most-recent-first
  // (newer sessions land on top), so reverse it so the original Assistant stays
  // on top and newer Assistants number up (Assistant, Assistant 2, ...).
  // Session rows expose only `updatedAt` (an activity timestamp, NOT creation),
  // so when a real createdAt is present sort by it ascending, else reverse the
  // ids baseline to reconstruct creation order.
  if (assistantRows.some((s: any) => s.createdAt)) {
    assistantRows = assistantRows
      .slice()
      .sort((a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0));
  } else {
    assistantRows = assistantRows.slice().reverse();
  }

  const current = currentSessionId();

  // Collapsed mode: compact vertical stack of status dots, no labels. One dot
  // per assistant session (in the same filtered ordered list) + one per head.
  if (!wide) {
    return (
      <div className="dp-agents-collapsed" aria-hidden="true">
        {assistantRows.map((a) => (
          <StateDot key={a.id} state={asistenteStatus(a)} size={10} />
        ))}
        {heads.map((h) => (
          <HeadStatusDot key={h.id} status={h.status} />
        ))}
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 4 }}>
      <button type="button" className="dp-new-session-btn" onClick={() => startSession()}>
        + New session with Assistant
      </button>
      <h2 className="dp-agents-heading">Agents</h2>
      <div className="dp-agents-list">
        {assistantRows.map((a, i) => {
          const name = i === 0 ? "Assistant" : `Assistant ${i + 1}`;
          const active = a.id === current;
          const menuOpen = openMenuId === a.id;
          return (
            <div
              key={a.id}
              className={
                "dp-agent-row" +
                (active ? " dp-agent-row--active" : "") +
                (menuOpen ? " dp-agent-row--menu-open" : "")
              }
            >
              <button
                type="button"
                className="dp-agent-open"
                onClick={() => {
                  if (!wide) expandSidebar();
                  openSession(a.id);
                }}
              >
                <StateDot state={asistenteStatus(a)} size={10} />
                <span className="dp-agent-name">{name}</span>
              </button>
              <button
                type="button"
                className="dp-agent-menu-btn"
                aria-label="Agent menu"
                aria-expanded={menuOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenuId(menuOpen ? null : a.id);
                }}
              >
                ⋯
              </button>
              {menuOpen && (
                <div className="dp-agent-menu">
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      setOpenMenuId(null);
                      try {
                        await archiveSession(a.id);
                      } catch {
                        // Ignored: the 5s archived poll reconciles the row out.
                      }
                    }}
                  >
                    Archive agent
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {heads.map((h) => (
          <div key={h.id} className="dp-agent-row dp-agent-row--static" aria-disabled="true">
            <HeadStatusDot status={h.status} />
            <span className="dp-agent-name">{h.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeepartmentsSettings — the settings.section body: a card with a two-option
// segment selector (Enabled/Disabled) that toggles the sidebar gate, persisted
// via the `/deepartments` `ui/config/set` RPC.
// ---------------------------------------------------------------------------
interface SettingsSectionProps {
  rpc: ClientCtx["connection"]["rpc"];
}

function DeepartmentsSettings(props: SettingsSectionProps) {
  const { rpc } = props;
  const enabled = useSyncExternalStore(
    uiStore.subscribe,
    () => uiStore.get().sidebarEnabled
  );

  const onChange = (val: boolean) => {
    // Optimistic local write: the gate reacts instantly; the RPC persists and
    // the 5s poll reconciles if the write ever failed.
    uiStore.set({ sidebarEnabled: val });
    void rpc
      .call("/deepartments", "ui/config/set", { sidebarEnabled: val })
      .catch(() => {
        // Ignored: the poll reconciles on the next cycle.
      });
  };

  const options = ["Enabled", "Disabled"] as const;

  return (
    <div className="dp-settings-card">
      <div className="dp-settings-head">
        <div className="dp-settings-labelbox">
          <span className="dp-settings-label">Deepartments</span>
          <span className="dp-settings-hint">
            Toggle the main-agents sidebar that replaces the session tree.
          </span>
        </div>
        <div className="dp-settings-select" role="radiogroup" aria-label="Deepartments sidebar">
          {options.map((opt) => {
            const active = opt === "Enabled" ? enabled : !enabled;
            return (
              <button
                key={opt}
                type="button"
                className={"dp-settings-option" + (active ? " dp-settings-option--active" : "")}
                aria-pressed={active}
                onClick={() => onChange(opt === "Enabled")}
              >
                {opt}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// apply — settings section (unconditional) + live sidebar gate (reactive).
// ---------------------------------------------------------------------------
const STYLE_ID = "deepartments-agents-sidebar-style";
const SETTINGS_STYLE_ID = "deepartments-settings-style";

export function apply(ctx: ClientCtx) {
  // The section + gate both speak over the /deepartments RPC; read the rpc
  // surface directly from the connection inject.
  const rpc = ctx.connection.rpc;

  // ---- Settings section — UNCONDITIONAL so the tab always exists --------
  ctx.effect(
    () => {
      const disposers: (() => void)[] = [];
      // The selector/section styles must render even when the sidebar is off, so
      // this style is owned by the section (always present while the plugin
      // loads), not by the gated sidebar effect.
      if (typeof document !== "undefined" && !document.getElementById(SETTINGS_STYLE_ID)) {
        const style = document.createElement("style");
        style.id = SETTINGS_STYLE_ID;
        style.textContent = SETTINGS_CSS;
        document.head.appendChild(style);
        disposers.push(() => {
          document.getElementById(SETTINGS_STYLE_ID)?.remove();
        });
      }
      const unregister = ctx.slots.register(
        {
          name: "settings.section",
          id: "deepartments",
          order: 30,
          label: "Deepartments",
          inject: () => ({ rpc })
        },
        DeepartmentsSettings
      );
      if (typeof unregister === "function") {
        disposers.push(unregister as () => void);
      }
      return () => {
        for (const dispose of disposers) dispose();
      };
    },
    "deepartments-client: settings.section"
  );

  // ---- Live sidebar gate — reactively driven by the /deepartments RPC ------
  // Polls `ui/config` every 5s + on window focus and pushes the value into the
  // shared uiStore; the uiStore subscription mounts/unmounts the sidebar shadow
  // + injected style. Runs in apply regardless of the sidebar being mounted.
  ctx.effect(
    () => {
      let active = false;
      let disposers: (() => void)[] = [];

      const sync = () => {
        const enabled = uiStore.get().sidebarEnabled;
        if (enabled && !active) {
          const next: (() => void)[] = [];
          const removeStyle = injectSidebarStyle();
          if (removeStyle) next.push(removeStyle);
          const unregister = registerSidebar(ctx);
          if (unregister) next.push(unregister);
          disposers = next;
          active = true;
        } else if (!enabled && active) {
          for (const dispose of disposers) dispose();
          disposers = [];
          active = false;
        }
      };

      const poll = async () => {
        try {
          const res = await rpc.call("/deepartments", "ui/config", {});
          if (res.ok) {
            const sidebarEnabled = (res.value as any)?.sidebarEnabled;
            if (typeof sidebarEnabled === "boolean") {
              uiStore.set({ sidebarEnabled });
            }
          }
          // On { ok: false } keep the last value; the next poll retries.
        } catch {
          // Ignore transient RPC failures; the next poll retries.
        }
      };

      const interval = window.setInterval(poll, 5000);
      const onFocus = () => {
        poll();
      };
      window.addEventListener("focus", onFocus);
      void poll(); // initial read

      const unsub = uiStore.subscribe(sync);
      sync(); // initial read from the store default
      return () => {
        window.clearInterval(interval);
        window.removeEventListener("focus", onFocus);
        unsub();
        for (const dispose of disposers) dispose();
        disposers = [];
        active = false;
      };
    },
    "deepartments-client: sidebar.workspaces (live)"
  );
}

/** Inject the sidebar stylesheet; returns a remover (or a no-op). */
function injectSidebarStyle(): (() => void) | undefined {
  if (typeof document === "undefined") return undefined;
  if (document.getElementById(STYLE_ID)) return undefined;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = AGENT_CSS;
  document.head.appendChild(style);
  return () => {
    document.getElementById(STYLE_ID)?.remove();
  };
}

/** Register the sidebar.workspaces shadow; returns a remover (or undefined). */
function registerSidebar(ctx: ClientCtx): (() => void) | undefined {
  const unregister = ctx.slots.register(
    {
      name: "sidebar.workspaces",
      priority: -1,
      inject: () => ({
        openSession: (id: string) => ctx.sessions.open(id),
        currentSessionId: () => ctx.sessions.list.getSnapshot().current,
        sessionSnapshot: () => ctx.sessions.list.getSnapshot(),
        startSession: () => ctx.workspaces.startSession(),
        rpc: ctx.connection.rpc,
        archiveSession: (id: string) => ctx.workspaces.archiveSession(id)
      })
    },
    AgentList
  );
  if (typeof unregister !== "function") return undefined;
  return unregister as () => void;
}
