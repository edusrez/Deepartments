// M-A — the context-threshold SMOKE fixture: a tiny Cordis plugin that
// registers the token-meter `contextPressure` projection unit (the hermetic
// test boot composes dsh-session-projection but NOT dsh-token-meter, so the
// unit is registered by this fixture — the production dsh-web-app profile
// registers it via dsh-token-meter). The definition surface matches the
// repo-pinned dsh-session-projection@0.1.0-rc.7 (`schema` + `view` — the
// harness 0.1.1-rc.2 uses `stateSchema` + `wire`; the bundle only reads the
// version-agnostic `snapshot()` wire view, so either shape feeds it). The
// VIEW mirrors the token-meter wire view ({contextWindow, pressureTokens,
// projectedTokens}) and the INIT state is a HIGH window-usage fixture
// (~62% of a 1 Mi window — the LIVE-data case: the real host sits at 59.8%),
// so every stub session (zero events → init) crosses the 50% threshold and
// the real daemon alerts the host.
//
// NO export default (pitfall 0001 — breaks `inject`).
export const name = 'ma-contextpressure-unit'

export function apply(ctx) {
  const registry = ctx.get('sessionProjections')
  if (registry === undefined) return
  registry.register({
    key: 'contextPressure',
    stateVersion: 1,
    schema: { parse: (v) => v },
    init: () => ({ contextWindow: 1048576, pressureTokens: 650000, surfaceTokens: 0, sampledSurfaceTokens: 0 }),
    apply: (state) => state,
    view: () => ({ contextWindow: 1048576, pressureTokens: 650000, projectedTokens: 650000 })
  })
}