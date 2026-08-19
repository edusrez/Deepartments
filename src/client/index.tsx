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
  parentLive: boolean;
}

interface AgentsValue {
  host: { id: string; name: string; department?: string };
  agents: AgentHead[];
}

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

// Minimal client root-context surface we rely on (provided by base bundles).
interface ClientCtx {
  effect(fn: () => void | (() => void), label?: string): void;
  slots: {
    register(
      options: {
        name: string;
        priority?: number;
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
// apply — register the slot entry + inject the stylesheet, both reversible.
// ---------------------------------------------------------------------------
const STYLE_ID = "deepartments-agents-sidebar-style";

export function apply(ctx: ClientCtx) {
  ctx.effect(
    () => {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = AGENT_CSS;
      document.head.appendChild(style);
      return () => {
        document.getElementById(STYLE_ID)?.remove();
      };
    },
    "deepartments-client: stylesheet"
  );

  ctx.effect(
    () => {
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
      return () => {
        if (typeof unregister === "function") (unregister as () => void)();
      };
    },
    "deepartments-client: sidebar.workspaces"
  );
}
