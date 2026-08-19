import { useEffect, useState } from "react";
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
 * A "Deepartments" tab in the DSH Settings UI exposes a switch that toggles the
 * sidebar shadow + injected `<style>` (persisted server-side via the
 * `deepartments` settings namespace). The section is registered unconditionally
 * so the tab always exists; the sidebar mount is gated LIVE on
 * `sidebarEnabled` — toggling the switch mounts/unmounts it with no refresh.
 *
 * Named exports only (AGENTS.md rule 1); no export default.
 */

export const name = "deepartments-client";
export const inject = ["slots", "sessions", "workspaces", "connection", "settingsScope"];

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
  parentLive: boolean;
}

interface AgentsValue {
  host: { id: string; name: string; department?: string };
  agents: AgentHead[];
}

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

// ---------------------------------------------------------------------------
// Settings scope surface (provided by @deepseek-ai/dsh-client-ui-settings).
// Structural, minimal — we only use what the Deepartments tab needs.
// ---------------------------------------------------------------------------
interface SettingsScopeSnapshot {
  status: "loading" | "ready" | "unavailable";
  value?: { sidebarEnabled?: boolean } | null;
  writable: boolean;
  base?: unknown;
  user?: unknown;
  revision?: number;
  mode?: string;
}

interface SettingsScopeControllerLike {
  getSnapshot(): SettingsScopeSnapshot;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<unknown>;
}

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
      getSnapshot(): { current: string | undefined; byId?: Record<string, any> };
    };
    open(id: string): unknown;
  };
  workspaces: {
    startSession(workspaceId?: string): unknown;
  };
  connection: {
    rpc: {
      call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>>;
    };
  };
  settingsScope: {
    bind(opts: { namespace: string }): SettingsScopeControllerLike;
  };
}

// Injected owner face received by AgentList.
interface AgentsOwner {
  wide: boolean;
  expandSidebar: () => void;
  openSession: (id: string) => void;
  currentSessionId: () => string | undefined;
  sessionNode: () => any;
  startSession: () => void;
  rpc: ClientCtx["connection"]["rpc"];
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
.dp-agent-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-primary);}
.dp-agent-dept{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-secondary);}

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
`;

// Settings section + switch styles. Kept OUT of AGENT_CSS because AGENT_CSS is
// gated by the sidebar toggle: the toggle itself must render even when the
// sidebar is off, so this style is injected unconditionally with the section.
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

/* switch: visually hidden checkbox + styled track/knob (mirrors dshmarket) */
.dp-switch{
  position:relative;flex:none;display:inline-flex;align-items:center;
  cursor:pointer;user-select:none;width:38px;height:22px;
}
.dp-switch-input{
  position:absolute;opacity:0;width:1px;height:1px;margin:0;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;
}
.dp-switch-track{
  position:absolute;inset:0;border-radius:99px;
  background:var(--dsw-alias-label-tertiary,#8b93a1);opacity:.45;
  transition:background .15s,opacity .15s;
}
.dp-switch-knob{
  position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:99px;
  background:#fff;box-shadow:0 1px 2px #00000040;transition:left .15s;
}
.dp-switch-input:checked + .dp-switch-track{opacity:1;background:var(--dsw-alias-state-success-primary,#16a34a);}
.dp-switch-input:checked + .dp-switch-track .dp-switch-knob{left:18px;}
.dp-switch-input:focus-visible + .dp-switch-track{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:2px;}
.dp-switch-input:hover + .dp-switch-track{background:var(--dsw-alias-interactive-bg-hover,#eef0f4);}
.dp-switch-input:hover:checked + .dp-switch-track{background:var(--dsw-alias-state-success-primary,#16a34a);}
.dp-switch[data-disabled="true"]{cursor:default;opacity:.5;}
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
  const { wide, expandSidebar, openSession, currentSessionId, sessionNode, startSession, rpc } = props;
  const [host, setHost] = useState<AgentsValue["host"] | null>(null);
  const [heads, setHeads] = useState<AgentHead[]>([]);

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

    fetchAgents();
    const interval = window.setInterval(fetchAgents, 5000);
    const onFocus = () => {
      fetchAgents();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onAsistenteClick = () => {
    if (!wide) expandSidebar();
    const id = currentSessionId();
    if (id !== undefined) {
      openSession(id);
    } else {
      startSession();
    }
  };

  // Collapsed mode: compact vertical stack of status dots, no labels.
  if (!wide) {
    const node = sessionNode();
    const aState = asistenteStatus(node);
    return (
      <div className="dp-agents-collapsed" aria-hidden="true">
        <StateDot state={aState} size={10} />
        {heads.map((h) => (
          <HeadStatusDot key={h.id} status={h.status} />
        ))}
      </div>
    );
  }

  const hostDept = host?.department ?? "User's Office";
  const aState = asistenteStatus(sessionNode());

  return (
    <div style={{ paddingTop: 4 }}>
      <h2 className="dp-agents-heading">Agents</h2>
      <div className="dp-agents-list">
        <button type="button" className="dp-agent-row" onClick={onAsistenteClick}>
          <StateDot state={aState} size={10} />
          <span className="dp-agent-name">Assistant</span>
          <span className="dp-agent-dept">{hostDept}</span>
        </button>
        {heads.map((h) => (
          <div key={h.id} className="dp-agent-row dp-agent-row--static" aria-disabled="true">
            <HeadStatusDot status={h.status} />
            <span className="dp-agent-name">{h.name}</span>
            {h.department ? <span className="dp-agent-dept">{h.department}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeepartmentsSettings — the settings.section body: a card with a switch that
// toggles the sidebar gate, persisted via the settings scope.
// ---------------------------------------------------------------------------
interface SettingsSectionProps {
  scope: SettingsScopeControllerLike;
}

function DeepartmentsSettings(props: SettingsSectionProps) {
  const { scope } = props;
  const [enabled, setEnabled] = useState<boolean>(
    () => scope.getSnapshot().value?.sidebarEnabled ?? true
  );
  const [writable, setWritable] = useState<boolean>(
    () => scope.getSnapshot().status === "ready" && scope.getSnapshot().writable
  );

  // Subscribe to the scope so the switch re-renders live (from the initial
  // load and on every remote settings/document-updated for this namespace).
  useEffect(() => {
    const applySnap = () => {
      const snap = scope.getSnapshot();
      setEnabled(snap?.value?.sidebarEnabled ?? true);
      setWritable(snap?.status === "ready" && !!snap?.writable);
    };
    const unsub = scope.subscribe(applySnap);
    applySnap();
    return () => {
      unsub();
    };
  }, [scope]);

  const disabled = !writable;
  const onToggle = () => {
    const snap = scope.getSnapshot();
    if (snap?.status !== "ready" || !snap?.writable) return;
    const next = !(snap.value?.sidebarEnabled ?? true);
    // Path set only — never replace, so unrelated stored fields survive.
    void scope.set("sidebarEnabled", next).catch(() => {
      // A rejected write (settings-rejected / settings-conflict) is recovered
      // automatically by the scope's next snapshot; nothing else to do here.
    });
  };

  return (
    <div className="dp-settings-card">
      <div className="dp-settings-head">
        <div className="dp-settings-labelbox">
          <span className="dp-settings-label">Deepartments</span>
          <span className="dp-settings-hint">
            Toggle the main-agents sidebar that replaces the session tree.
          </span>
        </div>
        <label
          className="dp-switch"
          data-disabled={disabled ? "true" : "false"}
          aria-label="Enable Deepartments sidebar"
        >
          <input
            type="checkbox"
            className="dp-switch-input"
            checked={enabled}
            disabled={disabled}
            onChange={onToggle}
            role="switch"
            aria-checked={enabled}
          />
          <span className="dp-switch-track" aria-hidden="true">
            <span className="dp-switch-knob" />
          </span>
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// apply — settings section (unconditional) + live sidebar gate (reactive).
// ---------------------------------------------------------------------------
const STYLE_ID = "deepartments-agents-sidebar-style";
const SETTINGS_STYLE_ID = "deepartments-settings-style";
const SETTINGS_NAMESPACE = "deepartments";

export function apply(ctx: ClientCtx) {
  // Bind the settings scope once (module/apply scope); both the section and the
  // sidebar gate read from the same live controller.
  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });

  // ---- Settings section — UNCONDITIONAL so the tab always exists --------
  ctx.effect(
    () => {
      const disposers: (() => void)[] = [];
      // The switch/section styles must render even when the sidebar is off, so
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
          inject: () => ({ scope })
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

  // ---- Live sidebar gate — reactive on the scope snapshot ----------------
  ctx.effect(
    () => {
      let active = false;
      let disposers: (() => void)[] = [];

      const sync = () => {
        const snap = scope.getSnapshot();
        // Default TRUE while the scope is still loading so the sidebar appears
        // immediately and reconciles when the persisted value arrives.
        const enabled = snap?.value?.sidebarEnabled ?? true;
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

      const unsub = scope.subscribe(sync);
      sync(); // initial read
      return () => {
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
        sessionNode: () => {
          const s = ctx.sessions.list.getSnapshot();
          const id = s.current;
          return id !== undefined ? s.byId?.[id] : undefined;
        },
        startSession: () => ctx.workspaces.startSession(),
        rpc: ctx.connection.rpc
      })
    },
    AgentList
  );
  if (typeof unregister !== "function") return undefined;
  return unregister as () => void;
}
