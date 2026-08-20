import { Fragment, memo, useCallback, useState, useSyncExternalStore } from "react";
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
  /** The head's stable root-agent session id (`head-<postId>`); opens it via
   * openSession exactly like an Assistant row (Batch 4a ships this field; if an
   * older server omits it the fallback below requires it, so a missing value
   * renders nothing clickable). */
  sessionId: string;
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

// ---------------------------------------------------------------------------
// Change-detection helpers (Batch 6b). The plugin's sidebar poll must NOT
// re-render when nothing changed: these compare poll payloads BY CONTENT so we
// can push into the agentStore only on real changes (reference-equality alone
// is useless — buildAgentRows allocates fresh arrays every poll).
// ---------------------------------------------------------------------------

// Heads may arrive in any order → compare as an id-keyed signature multiset.
function headSig(h: AgentHead): string {
  return [
    h.id, h.name, h.department ?? "", h.status, h.unread, h.running,
    h.sleeping, h.sessionLive, h.sessionId,
  ].join("\u0001");
}
function headsDiffer(a: AgentHead[], b: AgentHead[]): boolean {
  if (a.length !== b.length) return true;
  if (a.length === 0) return false;
  const bSigs = new Set(b.map(headSig));
  for (const h of a) if (!bSigs.has(headSig(h))) return true;
  // Same length + every a present in b (with equal signatures, incl. the id) ⇒
  // same multiset unless there are duplicate ids; guard the degenerate case.
  const aIds = new Set(a.map((h) => h.id));
  if (aIds.size !== a.length) return true;
  return false;
}
function hostDiffer(a: AgentsValue["host"] | null, b: AgentsValue["host"] | null): boolean {
  if (!a || !b) return a !== b;
  return a.id !== b.id || a.name !== b.name || a.department !== b.department;
}
function setsDiffer(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return true;
  for (const id of a) if (!b.has(id)) return true;
  return false;
}

// Shared external store for the polled roster (host + heads + archived session
// ids). ONE heartbeat (in apply) owns the RPC cadence and pushes here; AgentList
// consumes it reactively via useSyncExternalStore. getSnapshot returns a STABLE
// reference (replaced only on an actual content change) so uSES does not spin.
const agentStore = (() => {
  let state: { host: AgentsValue["host"] | null; heads: AgentHead[]; archived: Set<string> } = {
    host: null,
    heads: [],
    archived: new Set<string>(),
  };
  const listeners = new Set<() => void>();
  return {
    get: (): typeof state => state,
    set: (patch: {
      host?: AgentsValue["host"];
      heads?: AgentHead[];
      archived?: Set<string>;
    }) => {
      const next = { ...state };
      let changed = false;
      if (patch.host !== undefined) {
        if (hostDiffer(state.host, patch.host)) { next.host = patch.host; changed = true; }
        else next.host = state.host;
      }
      if (patch.heads !== undefined) {
        if (headsDiffer(state.heads, patch.heads)) { next.heads = patch.heads; changed = true; }
        else next.heads = state.heads;
      }
      if (patch.archived !== undefined) {
        if (setsDiffer(state.archived, patch.archived)) { next.archived = patch.archived; changed = true; }
        else next.archived = state.archived;
      }
      if (!changed) return;
      state = next;
      for (const l of listeners) l();
    },
    subscribe: (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
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
      /** The native sessions projection store (reactive: subscribe → uSES). */
      subscribe(fn: () => void): () => void;
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
  /** Subscribe to the native sessions projection store (for reactive highlight). */
  sessionsListSubscribe: (fn: () => void) => () => void;
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

/* collapsed mode: compact vertical dot stack, no labels. Both Assistant and head
   rows render the standard StateDot (no custom glyph containers). */
.dp-agents-collapsed{display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 0;}

/* head status-dot footprint helpers (Batch 6a, owner spec 2026-08-20). Both
   reserve the SAME 10px footprint as a <StateDot size={10} /> so every head row
   keeps identical alignment/margins whether or not it shows a dot. No fill
   override of StateDot. */
.dp-dot-sleep{flex:none;width:10px;height:10px;border-radius:50%;background:#9ca3af;}
.dp-dot-empty{flex:none;width:10px;height:10px;}

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

// Stable session-id prefix of the first-class ROOT-AGENT department heads
// (server: HeadSessionId = `head-<postId>`, Batch 1a/1b). Since a head is a
// non-subagent root agent, it now appears in the NATIVE sessions snapshot too
// (origin absent → `isAssistant` would otherwise list it). We exclude these
// ids from the Assistant rows so a head is rendered exactly ONCE — by the RPC
// `heads` list below (which renders the same native status dots as the
// Assistant rows) — and not double-listed as an "Assistant" row as well.
// Mirrors the deploy contract the server persists; the roster source is the
// `/deepartments` RPC, not the native tree.
const HEAD_SESSION_PREFIX = "head-";

// Status dot for department heads — owner spec 2026-08-20 (Batch 6a). Pure,
// render-safe: maps ONE head (its RPC status + native snapshot node) onto a
// single dot element with fixed precedence. Assistant rows keep their own
// native `asistenteStatus` mapping untouched.
//   pendingInteraction (native snapshot) -> StateDot warning   (orange)
//   status working                      -> StateDot ongoing    (spinner)
//   status completed-notice             -> StateDot done       (green novelty)
//   status sleeping                     -> .dp-dot-sleep       (gray round)
//   else (idle)                         -> .dp-dot-empty       (no dot, reserved)
function headDotFor(head: AgentHead, snapshot: any): ReactNode {
  const node = snapshot?.byId?.[head.sessionId];
  if (node?.pendingInteraction === true) {
    return <StateDot state="warning" size={10} />;
  }
  switch (head.status) {
    case "working":
      return <StateDot state="ongoing" size={10} />;
    case "completed-notice":
      return <StateDot state="done" size={10} />;
    case "sleeping":
      return <span className="dp-dot-sleep" aria-hidden="true" />;
    default:
      return <span className="dp-dot-empty" aria-hidden="true" />;
  }
}

// ONE shared row for BOTH Assistant sessions and department-head rows, so they
// are pixel-identical in anatomy, size, dots and the ⋯ menu (owner feedback
// 2026-08-20). The caller supplies the name, the exact <StateDot> element, and
// the open handler; optional menuItems render into the shared ⋯ dropdown.
interface AgentRowViewProps {
  name: string;
  /** The exact `<StateDot .../>` element to render (identity for Assistants). */
  dot: ReactNode;
  active: boolean;
  onOpen: () => void;
  /** Whether this row's ⋯ dropdown is the currently-open one. */
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** Rows without items still render the ⋯ button (enabled) with no dropdown. */
  menuItems?: { label: string; onSelect: () => void }[];
}

function AgentRowView({ name, dot, active, onOpen, menuOpen, onToggleMenu, menuItems }: AgentRowViewProps) {
  const rowClass =
    "dp-agent-row" +
    (active ? " dp-agent-row--active" : "") +
    (menuOpen ? " dp-agent-row--menu-open" : "");
  return (
    <div className={rowClass}>
      <button
        type="button"
        className="dp-agent-open"
        onClick={onOpen}
      >
        {dot}
        <span className="dp-agent-name">{name}</span>
      </button>
      <button
        type="button"
        className="dp-agent-menu-btn"
        aria-label="Agent menu"
        aria-expanded={menuOpen}
        onClick={(e) => {
          e.stopPropagation();
          onToggleMenu();
        }}
      >
        ⋯
      </button>
      {menuOpen && (
        <div className="dp-agent-menu">
          {menuItems?.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memoized row renderers (Batch 6b). AgentRowView itself is a plain function;
// these thin React.memo wrappers are what the AgentList maps over, so a poll
// that re-renders AgentList (e.g. one head's status changed) does NOT re-render
// the unchanged rows. Each wrapper builds its own dot + handlers from STABLE
// props (session/head references, primitives, useCallback'd callbacks), so the
// shallow memo comparison actually holds across re-renders.
// ---------------------------------------------------------------------------

interface AssistantRowViewProps {
  session: any;
  name: string;
  active: boolean;
  menuOpen: boolean;
  wide: boolean;
  expandSidebar: () => void;
  handleOpen: (id: string) => void;
  handleToggleMenu: (id: string) => void;
  handleArchive: (id: string) => void;
}
const AssistantRowView = memo(function AssistantRowView({
  session, name, active, menuOpen, wide, expandSidebar,
  handleOpen, handleToggleMenu, handleArchive,
}: AssistantRowViewProps) {
  const id = session.id ?? session.sessionId;
  return (
    <AgentRowView
      name={name}
      dot={<StateDot state={asistenteStatus(session)} size={10} />}
      active={active}
      onOpen={() => {
        if (!wide) expandSidebar();
        handleOpen(id);
      }}
      menuOpen={menuOpen}
      onToggleMenu={() => handleToggleMenu(id)}
      menuItems={[
        {
          label: "Archive agent",
          onSelect: () => { handleArchive(id); },
        },
      ]}
    />
  );
});

interface HeadRowViewProps {
  head: AgentHead;
  snapshot: any;
  active: boolean;
  menuOpen: boolean;
  wide: boolean;
  expandSidebar: () => void;
  handleOpen: (id: string) => void;
  handleToggleMenu: (id: string) => void;
  handleArchive: (id: string) => void;
}
const HeadRowView = memo(function HeadRowView({
  head, snapshot, active, menuOpen, wide, expandSidebar,
  handleOpen, handleToggleMenu, handleArchive,
}: HeadRowViewProps) {
  const id = head.sessionId;
  return (
    <AgentRowView
      name={head.name}
      dot={headDotFor(head, snapshot)}
      active={active}
      onOpen={() => {
        if (!wide) expandSidebar();
        // sessionId ships with Batch 4a; if an older server omits it, do
        // nothing rather than fall back to postId.
        if (id) handleOpen(id);
      }}
      menuOpen={menuOpen}
      onToggleMenu={() => handleToggleMenu(id)}
      menuItems={[
        {
          label: "Archive agent",
          onSelect: () => { if (id) handleArchive(id); },
        },
      ]}
    />
  );
});

// ---------------------------------------------------------------------------
// AgentList — renders the main agents into the sidebar.workspaces hole.
// ---------------------------------------------------------------------------
export function AgentList(props: AgentsOwner) {
  const { wide, expandSidebar, openSession, sessionSnapshot, sessionsListSubscribe, startSession, archiveSession } = props;
  // Roster (host + heads + archived ids) is pushed by the SHARED heartbeat in
  // apply() into agentStore; we consume it reactively. getSnapshot returns a
  // stable reference unless content actually changed, so a no-op poll does not
  // re-render us (Batch 6b, change-guard).
  const { heads, archived: archivedSet } = useSyncExternalStore(agentStore.subscribe, agentStore.get);
  // The native sessions projection store is ALREADY reactive (subscribe + uSES,
  // same as DeepartmentsSettings). Reading it here — instead of a 5s poll —
  // makes the active-row highlight update the moment the selection changes and
  // keeps the Assistant roster current without any extra polling.
  const snapshot = useSyncExternalStore(sessionsListSubscribe, sessionSnapshot);
  // Which Assistant row has its ⋯ (archive) menu open.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // Stable per-row callbacks (useCallback) so the memoized row wrappers skip
  // re-render when only the AgentList re-renders.
  const handleOpen = useCallback(
    (id: string) => {
      if (!wide) expandSidebar();
      openSession(id);
    },
    [wide, expandSidebar, openSession]
  );
  const handleToggleMenu = useCallback((id: string) => {
    setOpenMenuId((prev) => (prev === id ? null : id));
  }, []);
  const handleArchive = useCallback((id: string) => {
    setOpenMenuId(null);
    // Ignored: the heartbeat's archived poll reconciles the row out.
    void archiveSession(id).catch(() => {});
  }, [archiveSession]);

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

  const current = snapshot?.current;

  // Collapsed mode: compact vertical stack of status dots, no labels. One dot
  // per assistant session (in the same filtered ordered list) + one per head.
  if (!wide) {
    return (
      <div className="dp-agents-collapsed" aria-hidden="true">
        {assistantRows.map((a) => (
          <StateDot key={a.id} state={asistenteStatus(a)} size={10} />
        ))}
        {heads.map((h) => (
          <Fragment key={h.id}>{headDotFor(h, snapshot)}</Fragment>
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
          const id = a.id ?? a.sessionId;
          return (
            <AssistantRowView
              key={id}
              session={a}
              name={name}
              active={id === current}
              menuOpen={openMenuId === id}
              wide={wide}
              expandSidebar={expandSidebar}
              handleOpen={handleOpen}
              handleToggleMenu={handleToggleMenu}
              handleArchive={handleArchive}
            />
          );
        })}
        {/* Department heads: rendered through the SAME shared row as Assistants
            (pixel-identical anatomy/dot/⋯ menu). Filtered by the archived set
            exactly like Assistant rows, so archiving a head hides it (it
            re-materializes on the next boot because its posts.json entry
            persists — a deliberate, harmless behavior). */}
        {heads
          .filter((h) => !archivedSet.has(h.sessionId))
          .map((h) => (
            <HeadRowView
              key={h.id}
              head={h}
              snapshot={snapshot}
              active={h.sessionId === current}
              menuOpen={openMenuId === h.sessionId}
              wide={wide}
              expandSidebar={expandSidebar}
              handleOpen={handleOpen}
              handleToggleMenu={handleToggleMenu}
              handleArchive={handleArchive}
            />
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

  // ---- Live sidebar gate — ONE shared heartbeat (Batch 6b) -----------------
  // A SINGLE setInterval + focus/visibility handling drives BOTH the ui/config
  // gate poll (mounts/unmounts the sidebar shadow) AND the AgentList roster
  // fetch (agents + archived). Previously two independent 5s intervals ran
  // concurrently (~3 RPCs per tick even when idle). Polling pauses while the
  // tab is hidden (visibilityState) and resumes on focus/visibilitychange.
  // The ui/config poll runs ALWAYS (so the toggle is honored while the sidebar
  // is off); the roster (agents + archived) RPCs run ONLY while the sidebar is
  // mounted, mirroring the old AgentList-mounted polling.
  ctx.effect(
    () => {
      let disposed = false;
      let sideActive = false;
      let disposers: (() => void)[] = [];

      const visible = () =>
        typeof document === "undefined" ? true : document.visibilityState !== "hidden";

      // Fetch the roster (host + heads) + archived ids ONLY while the sidebar
      // shadow is mounted. Change-guarded: agentStore pushes only on real
      // content change, so an idle poll does not re-render AgentList.
      const fetchRoster = async () => {
        if (!sideActive) return;
        try {
          const sid = ctx.sessions.list.getSnapshot().current;
          const res = await rpc.call("/deepartments", "agents", { sessionId: sid ?? undefined });
          if (disposed || !res.ok) return;
          const value = res.value as AgentsValue;
          agentStore.set({
            host: value.host,
            heads: Array.isArray(value.agents) ? value.agents : [],
          });
        } catch {
          // Keep last data; the next poll retries silently.
        }
        try {
          const ares = await rpc.call("/api", "workspace.list", {});
          if (disposed || !ares.ok) return;
          const value = ares.value as any;
          const archived: string[] = Array.isArray(value?.archivedSessionIds)
            ? value.archivedSessionIds
            : [];
          agentStore.set({ archived: new Set<string>(archived) });
        } catch {
          // Keep last set; the next poll retries silently.
        }
      };

      // ui/config gate poll — ALWAYS (so the selector is honored while off).
      const pollConfig = async () => {
        try {
          const res = await rpc.call("/deepartments", "ui/config", {});
          if (disposed || !res.ok) return;
          const sidebarEnabled = (res.value as any)?.sidebarEnabled;
          if (typeof sidebarEnabled === "boolean") {
            uiStore.set({ sidebarEnabled });
          }
          // On { ok: false } keep the last value; the next poll retries.
        } catch {
          // Ignore transient RPC failures; the next poll retries.
        }
      };

      const sync = () => {
        const enabled = uiStore.get().sidebarEnabled;
        if (enabled && !sideActive) {
          const next: (() => void)[] = [];
          const removeStyle = injectSidebarStyle();
          if (removeStyle) next.push(removeStyle);
          const unregister = registerSidebar(ctx);
          if (unregister) next.push(unregister);
          disposers = next;
          sideActive = true;
          // Sidebar just mounted: populate the roster immediately.
          void fetchRoster();
        } else if (!enabled && sideActive) {
          for (const dispose of disposers) dispose();
          disposers = [];
          sideActive = false;
        }
      };

      const run = () => {
        if (!visible()) return;
        void pollConfig();
        void fetchRoster();
      };

      const interval = window.setInterval(run, 5000);
      const onFocus = () => run();
      const onVisibility = () => {
        if (visible()) run();
      };
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVisibility);
      void pollConfig(); // initial config read (even while sidebar is off)

      const unsub = uiStore.subscribe(sync);
      sync(); // initial read from the store default
      return () => {
        disposed = true;
        window.clearInterval(interval);
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("visibilitychange", onVisibility);
        unsub();
        for (const dispose of disposers) dispose();
        disposers = [];
        sideActive = false;
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
        sessionsListSubscribe: (fn: () => void) => ctx.sessions.list.subscribe(fn),
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
