/**
 * dsh-deepartments client plugin.
 *
 * U1 — custom-sidebar removal: the "main agents" sidebar (the workspace-slot
 * shadow with agent/head rows, the injected styles incl. the native New Session
 * CSS patch, the Deepartments settings card and its config gate) has been
 * REMOVED. The client half is now INTENTIONALLY INERT: the native dsh sidebar
 * (WorkspaceBrowser with its New Session button) renders unshadowed, and this
 * module registers nothing. The server-side `/deepartments` `agents`/`list` RPC
 * is kept (test/rpc-channel.test.js) as the client roster heartbeat — it is not
 * part of the removed sidebar.
 *
 * `name`/`inject`/`apply` are kept as the canonical module surface the DSH
 * client loader requires; `apply` is a no-op.
 *
 * Named exports only (AGENTS.md rule 1); no export default.
 */

export const name = "deepartments-client";
export const inject = ["slots", "sessions", "workspaces", "connection"];

/** Inert by design (U1 — custom sidebar removed): registers no slots, no
 * styles, no RPC polls. The native sidebar is the surface. */
export function apply(): void {
  // no-op
}