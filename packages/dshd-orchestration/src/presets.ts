/**
 * Deepartments — DECOUPLING SUB-PASO 6: PRESETS ORCHESTRATION FACTORY
 * (HITO 3 DECOUPLING, brief step 6 — THE LAST ZONE BEFORE boot): the
 * presets/journal/wake-pack zone of applyInvoke — the per-head preset
 * materialization Batch 1a/4a (PRESET_ID / WORKER_PRESET_ID /
 * WORKER_AGENT_OPTIONS / HOST_AGENT_OPTIONS / resolveMaterializeAgentOptions /
 * repoRoot / dshHome / materializePreset / writePresetFile /
 * materializeHeadPreset) + the Task T1 journal/archive machinery
 * (journalPathFor / archive* / truncateText / extract* / contentToText /
 * serializeSession* / buildSessionLogStub / deriveIndexEntry / captureSessionLog
 * / archiveJournalEntry / archiveCycle / writeJournal / bumpHostSleepCounter /
 * bumpPostSleepCounter / readJournal) + the coordinator/department resolvers
 * (coordinatorForPost / departmentForPost / departmentForEntry) + the W8-d
 * wake-pack assembly (subagentRoles consume / roleForSessionLive /
 * assembleHeartbeat / wakePackService construction), 898 LOCs of
 * `applyInvoke`, src/invoke.ts 3022-3919.
 *
 * MOVEMENT-ONLY. The zone is hoisted VERBATIM into this factory, and
 * `applyInvoke` invokes it via `createPresetsOrchestration` AT THE SAME FIBER
 * POSITION — the same closures, the same order, the same semantics (0 behavior
 * change). The state these closures read/mutate is the SAME by-reference
 * maps/registries passed in `deps`. The zone-declared names the REST of
 * applyInvoke consumes (the spawn/tools/delivery factories + the daemons + the
 * agent/pre-step registration) are returned as the PresetsSurface and rebound
 * by the apply-fiber destructure at the SAME position.
 *
 * SEAM DECISIONS (documented, MOVEMENT-ONLY preserved):
 *  - the zone is 3022-3919 (898 LOCs), NOT the brief's 3015-3921 (907): the
 *    boot-repair kick `hostsLoaded.then(...)` + the B3 cutover note (3015-3021)
 *    are BOOT-zone content (zone 7, not yet cut — they stay byte-identical in
 *    invoke.ts) and the wake-pack `agent/pre-step` REGISTRATION (3920-3927) is
 *    a CONSUMER that stays in invoke.ts reading the destructured
 *    `wakePackService` (the SB4 consumer pattern — like the W1 daemon stayed).
 *  - MOVEMENT DEVIATION D1 (`repoRoot`): the zone's inline
 *    `const repoRoot = path.resolve(fileURLToPath(new URL('.',
 *    import.meta.url)), '..')` initializer is MODULE-POSITION-DEPENDENT — in
 *    invoke.ts (lib/invoke.js at the lib/ ROOT) one '..' reaches the repo root,
 *    but this factory compiles to lib/core/orchestration/presets.js (THREE
 *    levels deep), so the IDENTICAL value requires three '..'. The factory
 *    keeps the declaration VERBATIM except the depth ('..' → '../../../../../'
 *    equivalent — three ups), value identical (both resolve to the plugin repo
 *    root, verified); repoRoot is a PresetsSurface member so the apply-fiber
 *    destructure rebinds it and the downstream consumers (spawn/tools/delivery
 *    factories, daemons, webServer) read the SAME value. The rest of the zone
 *    is byte-identical to HEAD (897/898 lines in the embedded text).
 *  - `messagesStoreReady` (the wake-pack's lazy store thunk, line 3907) is a
 *    LATE seam: the DeliverySurface binding is built at the delivery factory
 *    position (AFTER this factory) — passed as `late.messagesStoreReady`
 *    (a getter over the apply-scope `deliverySurface`), rebound here as a
 *    delegating THENABLE (the zone awaits it as a value), dereferenced only at
 *    CALL time (wake-pack assembly, post-boot — the apply-scope TDZ is never
 *    entered).
 *  - 16 DIRECT deps by reference: the boot-zone apply-scope bindings
 *    (config/stateDir/org/agents/byPost/hosts/hostIdForSession/refreshPresence/
 *    persistHosts/postIdForChild/deferredSleepReplace/wakePackInjected — all
 *    defined BEFORE this position, 0 TDZ) + the invoke.ts module-scope pure
 *    helpers (isUsableAgentOptions / yamlList / computeHostSleepSurfacePlan /
 *    readPresenceStateFile — not importable without a cycle, passed by ref).
 *  - `subagentRoles` is read INSIDE the zone via `ctx.get('deepartments
 *    .subagentRoles')` (the D3 service) — the factory has ctx, so the zone's
 *    inline get resolves identically (the minimal-composition fallback to
 *    `roleForSession` is preserved VERBATIM).
 * 0 ctx.provide (the P1 invariant, asserted by the lock).
 *
 * Pattern (the PASO 1 / sub-pasos 2-5 proof): closures hoisted → the late
 * delivery seam passed as a `late` GETTER → rebound as a delegating THENABLE →
 * the surface returned at the SAME positions. The bundle stays a PURE SERVICE
 * CONSUMER: this factory performs NO ctx.provide (P1 — the `deepartments.presets`
 * service surface the brief planned via ctx.provide is deferred to the hito-4
 * package migration; the seams are the returned PresetsSurface members).
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdir, readFile, writeFile, readdir, copyFile, stat, rename, unlink, appendFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// LANE 0.2.2 (gap 2) — the bundle-local VALUES (head-presets helpers +
// appendToolsetAudit) become DEPS passed by reference (functions, never
// imports); roleForSession/buildSubagentOrientation resolve from dshd-core
// (src/role-orient.ts is a re-export bridge of the core package).
import { roleForSession, buildSubagentOrientation } from 'dshd-core'
import type { SubagentRole, SubagentRolesService } from 'dshd-core'
import { buildSleepJournalMessage } from 'dshd-core'
import { createWakePackService } from 'dshd-core'
import type { WakePackService, HostSleepSurfacePlan } from 'dshd-core'
import type { PresenceState } from 'dshd-gui'
import {
  readInboxByPost,
  HEALTH_ERROR_WINDOW_MS,
  buildPostSnapshot,
  scanHostWaits,
  resolveSystemWaitMs,
  buildHeartbeatSection,
  scanInterruptedTurn
} from 'dshd-health'
import type { HealthSessionEvent, HostWaitPostInput, HeartbeatRow } from 'dshd-health'
import type { PostEntry, HostEntry } from 'dshd-core'
import type { MessagesStore } from 'dshd-core'
import type { DeliverySurface } from './delivery.js'
import type { Config, CoordinatorConfig, DepartmentConfig } from './org-types.js'

// ---------------------------------------------------------------------------
// Local structural mirrors of the bundle-local harness views (src/invoke.ts
// declares these at module scope but does NOT export them — the export-parity
// lock freezes lib/invoke.js's export surface, so the factory re-declares the
// EXACT same structural shapes instead of importing from the bundle module
// (which would also create a require cycle).
// ---------------------------------------------------------------------------

/** Agent-scoped creation options (mirrors the bundle-local `AgentOptionsLike`). */
interface AgentOptionsLike {
  provider?: string
  model?: string
  maxTokens?: number
  reasoningEffort?: string
}

/** Loose structural view of a live `Agent` (the shape `ctx.agents.get(id)`
 * returns — assembleHeartbeat reads `.session.events` / `.status`). Mirrors the
 * bundle-local `AgentLike` of src/invoke.ts (structural subset: the fields the
 * zone reads). */
interface AgentLike {
  id: string
  status: string
  session?: { events: unknown[] }
}

/** Structural view of the `agents` service surface the zone reads (`get` only).
 * Mirrors the bundle-local `AgentsLike` of src/invoke.ts. */
interface AgentsLike {
  get(id: string): AgentLike | undefined
}

/** The apply-scope bindings the presets zone captures (src/invoke.ts
 * closures + the shared mutable state), passed BY REFERENCE — the factory reads
 * and mutates the SAME maps/registries the rest of applyInvoke uses (AGENTS.md
 * rule 4 — no module-global mutable state; the instance lives on the apply
 * fiber). `late` carries the seams that do NOT exist at the invocation position
 * (3022): a GETTER over the apply-scope bindings the zone dereferences at CALL
 * time (post-boot). */
export interface PresetsFactoryDeps {
  /** The plugin Config (assembleHeartbeat reads config.health). */
  config: Config
  /** The org config (departments + pacing — the wake-pack directory). */
  org: Config['org']
  /** The org stateDir (the journal/archive roots + the toolset audit). */
  stateDir: string
  /** The live agents service (optional — assembleHeartbeat's live reads). */
  agents: AgentsLike | undefined
  /** The live durable post catalog (BY REFERENCE — writeJournal's boundarySeq +
   * assembleHeartbeat's rows). */
  byPost: Map<string, PostEntry>
  /** The live host registry (BY REFERENCE — writeJournal's host boundarySeq +
   * assembleHeartbeat's host row). */
  hosts: Map<string, HostEntry>
  /** The registry session→host resolver (the wake-pack deps). */
  hostIdForSession: (sessionId: string) => string
  /** The presence refresh hook (the wake-pack deps). */
  refreshPresence: () => void
  /** The host-registry persist hook (the wake-pack deps). */
  persistHosts: () => void
  /** The childId→postId resolver (the wake-pack deps). */
  postIdForChild: (childId: string) => string | undefined
  /** The deferred sleep-replace map (BY REFERENCE — the wake-pack deps). */
  deferredSleepReplace: Map<string, string>
  /** The injected wake-pack set (BY REFERENCE — the wake-pack deps). */
  wakePackInjected: Set<string>
  /** The module-scope helpers of invoke.ts (not importable without a cycle —
   * passed by reference, SB4 precedent): */
  isUsableAgentOptions: (agentOptions: AgentOptionsLike | undefined) => boolean
  yamlList: (items: readonly string[]) => string
  computeHostSleepSurfacePlan: (nodes: readonly number[]) => HostSleepSurfacePlan
  readPresenceStateFile: (stateDir: string) => PresenceState
  /** LANE 0.2.2 (gap 2) — the bundle-local pure helpers (src/head-presets.ts +
   * src/toolset-audit.ts — injected by reference, the "functions, never
   * imports" rule): */
  HEAD_PRESET_BASE_ID: string
  headPresetIdFor: (departmentId: string) => string
  headPresetNameCore: (coordinator: CoordinatorConfig) => string
  headPresetNameFor: (coordinator: CoordinatorConfig) => string
  buildHeadPresetComposition: (baseText: string, presetName: string, departmentName: string) => string
  buildHeadPresetMetadata: (displayName: string) => string
  appendToolsetAudit: (stateDir: string | undefined, entry: Record<string, unknown>) => void
  /** LATE seams — the DeliverySurface members (built at the delivery factory
   * position, AFTER this factory) that the zone dereferences only at CALL time
   * (the wake-pack assembly, post-boot — the apply-scope TDZ is never entered). */
  late: {
    /** The DeliverySurface's boot-opened message store promise. */
    messagesStoreReady: DeliverySurface['messagesStoreReady']
  }
}

/** The zone-declared members the rest of applyInvoke consumes at the SAME
 * positions (the spawn/tools/delivery factories + the W1/W6 daemons + the
 * agent/pre-step registration) — rebind by the apply-fiber destructure. */
export interface PresetsSurface {
  PRESET_ID: string
  WORKER_PRESET_ID: string
  WORKER_AGENT_OPTIONS: AgentOptionsLike
  HOST_AGENT_OPTIONS: AgentOptionsLike
  resolveMaterializeAgentOptions: (candidate: AgentOptionsLike | undefined) => AgentOptionsLike
  repoRoot: string
  dshHome: () => string
  materializePreset: (presetId: string) => Promise<void>
  materializeHeadPreset: (department: DepartmentConfig) => Promise<void>
  journalPathFor: (memberId: string) => string
  writeJournal: (memberId: string, roomId: string, summary: string, decisions: string[], constraints: string[], openItems: string[], currentStep?: string, archive?: { sessionId?: string; wakeCounter?: number; archiveSeq?: string; lastWakeMs?: number; boundarySeq?: number }) => Promise<string>
  bumpHostSleepCounter: (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }) => Promise<string>
  bumpPostSleepCounter: (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }) => Promise<string>
  readJournal: (memberId: string) => Promise<string | undefined>
  coordinatorForPost: (postId: string) => CoordinatorConfig | undefined
  departmentForPost: (postId: string) => DepartmentConfig | undefined
  departmentForEntry: (entry: PostEntry) => DepartmentConfig | undefined
  assembleHeartbeat: (hostId: string) => string | undefined
  roleForSessionLive: (sessionId: string) => SubagentRole
  wakePackService: WakePackService
}

/**
 * Build the PRESETS ORCHESTRATION surface on the apply fiber (AGENTS.md rule 4
 * — no module-global mutable state; invoked by applyInvoke at the SAME fiber
 * position where the hoisted zone used to live). The closures below are the
 * ORIGINAL zone closures, moved VERBATIM — the diff is movement-only.
 */
export function createPresetsOrchestration(ctx: Context, deps: PresetsFactoryDeps): PresetsSurface {
  const {
    config,
    org,
    stateDir,
    agents,
    byPost,
    hosts,
    hostIdForSession,
    refreshPresence,
    persistHosts,
    postIdForChild,
    deferredSleepReplace,
    wakePackInjected,
    isUsableAgentOptions,
    yamlList,
    computeHostSleepSurfacePlan,
    readPresenceStateFile,
    HEAD_PRESET_BASE_ID,
    headPresetIdFor,
    headPresetNameCore,
    headPresetNameFor,
    buildHeadPresetComposition,
    buildHeadPresetMetadata,
    appendToolsetAudit,
    late
  } = deps

  // The LATE seam — resolved AT CALL TIME through the accessor object (the
  // DeliverySurface member is built LATER on this fiber; the zone dereferences
  // it only when the wake-pack assembly fires — post-boot — so the apply-scope
  // TDZ is never entered). The store seam is a THENABLE delegating to the
  // surface's boot-opened promise (the zone awaits `messagesStoreReady` as a
  // value via `messagesStoreReady: () => messagesStoreReady`, so the binding
  // must be a thenable — the tools.ts:793 pattern).
  const messagesStoreReady = {
    then(resolve: (value: MessagesStore) => unknown, reject: (reason?: unknown) => unknown) {
      return late.messagesStoreReady.then(resolve, reject)
    }
  } as Promise<MessagesStore>

  // =========================================================================
  // PRESETS ZONE (hoisted VERBATIM from applyInvoke 3022-3919 — the same
  // closures, the same order, the same semantics). MOVEMENT DEVIATION D1: the
  // `repoRoot` initializer is module-position-dependent (this module compiles
  // to lib/core/orchestration/presets.js — THREE levels below the repo root,
  // unlike lib/invoke.js at the lib/ root), so the IDENTICAL value is computed
  // with three '..' instead of one (verified: both resolve to the plugin repo
  // root). All other lines are byte-identical to HEAD.
  // =========================================================================
  // --- department HEADS: FIRST-CLASS ROOT AGENTS (Batch 1a) ------------------
  // A configured coordinator is materialized as its OWN root agent (NOT a
  // continuable subagent): created/resumed via ctx.agents.create/resume from
  // the plugin's ROOT service context (so it lands in agents.roots(), with no
  // origin === 'subagent', and the GUI/sidebar renders it as a main-agent row
  // exactly like "Assistant"). Batch 4a: each head materializes a PER-HEAD
  // preset (`deepartments-head-<departmentId>`, derived from the generic base +
  // the department role) so the head is a NATIVE, openable session. PRESET_ID
  // (the generic `deepartments-head` base) remains as the TEMPLATE and as the
  // FALLBACK for a head whose department cannot be resolved.
  const PRESET_ID = HEAD_PRESET_BASE_ID
  /** Batch 3a: the dedicated DISPOSABLE-worker preset (mirrors the head preset
   * but framed as a temporary rank-and-file researcher). Materialized into the
   * harness-home user preset root alongside the head preset. */
  const WORKER_PRESET_ID = 'deepartments-worker'
  /** F7 (owner decision 2026-08-23 — provider migration to opencode-zen): the
   * runtime-materialized department workers run the SAME provider/model route
   * as the coordinator (cordis.patch.yml — opencode-zen /
   * deepseek-v4-flash, reasoningEffort max). ONE source shared by
   * the three spawn paths (dept_post_create, dept_job_run, dept_worker_spawn)
   * so the worker route cannot drift from the config again. */
  const WORKER_AGENT_OPTIONS: AgentOptionsLike = {
    provider: 'opencode-zen',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'max'
  }
  /** VARIANT-2 (2026-08-24) — post-restart host AgentOptions intermittently
   * empty: the plugin's OWN D4 dormant-host bus delivery (busDeliverToHost)
   * resumes the host with `agents.resume({ resumeSessionId, setup })` and NO
   * agentOptions → `agent.options = {}` → the dsh-agent-loop request waterfall
   * throws `agent "session-<uuid>" has no provider/model` at the first
   * post-boot materialization. The D4 setup only mounts the 'deepartments'
   * preset and does NOT installSelection, so `agent.options` MUST be the
   * carrier — mirror heads/workers (WORKER_AGENT_OPTIONS /
   * coordinator.agentOptions) to make the HOST symmetric: pass the FULL
   * constant (provider/model/reasoningEffort) at the D4 resume (invoke.ts:8760)
   * so `this.options` is non-empty at EVERY host materialization → the
   * request waterfall returns it → no `no provider/model`. NOTE:
   * defaultModelSelection().agentOptions() (dsh-host-apiproxy) DROPS
   * reasoningEffort — pass the FULL constant, not a provider/model-only
   * partial. ONE source shared by the D4 host resume so the host route cannot
   * drift from the config again (mirrors the F7 WORKER_AGENT_OPTIONS). */
  const HOST_AGENT_OPTIONS: AgentOptionsLike = {
    provider: 'opencode-zen',
    model: 'deepseek-v4-flash-vision-exp',
    reasoningEffort: 'max'
  }
  /** fb-6 (QH — the resume/re-materialization "has no provider/model" class):
   * the ONE materializePost AgentOptions resolution point — the configured
   * `coordinator?.agentOptions` when it carries a USABLE provider/model, else
   * the WORKER_AGENT_OPTIONS fallback. An interrupted SPAWN leaves the post
   * registered with its durable session PRESENT but with NO usable
   * AgentOptions (a department-less/legacy worker — or a config-less head —
   * has no coordinator row) → the pre-fix waterfall threw
   * `agent "session-<uuid>" has no provider/model` at the resume AND at the
   * create-fresh fallback. Workers AND heads both run the flash route today,
   * so the fallback is the SAME constant for both; the HOST never passes
   * through here — busDeliverToHost passes the FULL HOST_AGENT_OPTIONS at its
   * own D4 resume (untouched). ZERO regression: a usable candidate is returned
   * unchanged, so normal spawns/materializations pass through byte-identical. */
  const resolveMaterializeAgentOptions = (candidate: AgentOptionsLike | undefined): AgentOptionsLike =>
    isUsableAgentOptions(candidate) ? (candidate as AgentOptionsLike) : WORKER_AGENT_OPTIONS
  /** Repo root, used as the preset source AND as the FINAL fallback cwd for
   * head/worker sessions (the canonical cwd is the workspace root path — see
   * `resolveWorkspaceRootPath`). `new URL('.', import.meta.url)` already yields
   * the compiled `lib/` directory (of lib/invoke.js in dev), so one `'..'` up
   * is the repo root. */
  const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
  // the plugin's ROOT service context — so it is owned by no live parent,
  // lands in agents.roots(), carries no `origin: 'subagent'`, and the
  // GUI/sidebar renders it as a main-agent row exactly like "Assistant".
  //   * stable id `SessionId(\`head-<postId>\`)`
  //   * `meta: { cwd: <workspace root path>, origin: undefined, agentPreset: 'deepartments-head' }`
  //   * `agentOptions` from the coordinator config
  //   * a `setup(agentCtx)` that mounts the dedicated 'deepartments-head'
  //     preset AND registers the head's dept_* board tools scoped to it.
  //
  // Root creation semantics: ensureHead is idempotent — live → reuse; a
  // durable session → resume; else → create. Permanent = configured; there is
  // no re-materialization fight because root agents are not re-spawned by
  // config the way materializeHeads re-spawned subagents (a head only gets
  // CREATED here when its durable sessionId is absent from the registry).
  //
  // Preset availability (design decision — see report): dsh-agent-presets
  // Config.roots is STATIC (there is no runtime root-registration API; rc.8
  // dsh-agent-presets types/index.d.ts:115-159, preset.d.ts:47-57), so Batch
  // 1a uses the FALLBACK: at apply() we idempotently materialize
  // `presets/deepartments-head/` into the harness-home user-preset root
  // `<DSH_HOME>/.agent-presets/` — the root the roster scans under
  // includeUserRoot (discovery.d.ts:32 USER_PRESET_DIR='.agent-presets',
  // index.js:852), so agentPresets.resolve('deepartments-head') finds it.

  /** Harness home: `$DSH_HOME` if set, else `~/.dsh` (mirrors
   * resolveDshHome() in dsh-home-paths without a hard dependency). */
  const dshHome = (): string => {
    const env = process.env.DSH_HOME
    if (env !== undefined && env.trim() !== '') return env.trim()
    return path.join(os.homedir(), '.dsh')
  }

  /** Resolve the plugin's own directory containing `presets/<presetId>/`
   * (the plugin's own repo root, under presets/). */
  const presetSourceDir = (presetId: string): string =>
    path.join(repoRoot, 'presets', presetId)

  /** Idempotently materialize `presets/<presetId>/` into the harness home's
   * `.agent-presets/` user root so the given preset is resolvable. Used for the
   * head preset AND the disposable-worker preset (Batch 3a). The copy is
   * skipped when the destination already has the same file. Non-fatal: a failed
   * materialization just means the matching setup mounts nothing (board tools
   * are always installed regardless). */
  const materializePreset = async (presetId: string): Promise<void> => {
    const srcDir = presetSourceDir(presetId)
    const dstDir = path.join(dshHome(), '.agent-presets', presetId)
    try {
      await mkdir(dstDir, { recursive: true })
      const files = await readdir(srcDir)
      for (const file of files) {
        const src = path.join(srcDir, file)
        const dst = path.join(dstDir, file)
        const isFile = (await stat(src)).isFile()
        if (!isFile) continue
        // Skip when the same file already exists (idempotent materialization).
        try {
          const existing = await readFile(dst, 'utf8')
          const incoming = await readFile(src, 'utf8')
          if (existing === incoming) continue
        } catch {
          /* destination absent/corrupt → (re)write */
        }
        await copyFile(src, dst)
      }
      ctx.logger.info(`[deepartments] preset "${presetId}" materialized at ${dstDir}`)
    } catch (error: unknown) {
      // Non-fatal: if the preset cannot be materialized (e.g. source absent), the
      // matching setup simply mounts nothing and still gets its board tools.
      ctx.logger.warn(`[deepartments] preset "${presetId}" materialization skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Write one generated preset file to a destination, skipping when the same
   * content is already present (idempotent materialization — mirrors the
   * skip-on-identical check in `materializePreset`). */
  const writePresetFile = async (dst: string, content: string, presetId: string): Promise<void> => {
    try {
      const existing = await readFile(dst, 'utf8')
      if (existing === content) return
    } catch {
      /* destination absent/corrupt → (re)write */
    }
    await writeFile(dst, content, 'utf8')
    ctx.logger.info(`[deepartments] preset "${presetId}" file ${dst} written`)
  }

  /** Idempotently generate + materialize ONE PER-HEAD preset
   * (`deepartments-head-<departmentId>`) into the harness home's `.agent-presets/`
   * user root (Batch 4a). The composition is derived from the generic
   * `deepartments-head` base template + the department role line; the metadata
   * is `name: "<head title> - Deepartments"`. Non-fatal: a failed materialization
   * just means the head's setup mounts the generic fallback (board tools are
   * always installed regardless). */
  const materializeHeadPreset = async (department: DepartmentConfig): Promise<void> => {
    const coordinator = department.coordinator
    if (coordinator === undefined) return
    const presetId = headPresetIdFor(department.id)
    const dstDir = path.join(dshHome(), '.agent-presets', presetId)
    try {
      await mkdir(dstDir, { recursive: true })
      const headName = headPresetNameCore(coordinator)
      const baseComposition = await readFile(path.join(repoRoot, 'presets', PRESET_ID, 'agent.cordis.yml'), 'utf8')
      const composition = buildHeadPresetComposition(baseComposition, headName, department.name)
      await writePresetFile(path.join(dstDir, 'agent.cordis.yml'), composition, presetId)
      await writePresetFile(path.join(dstDir, 'preset.yml'), buildHeadPresetMetadata(headPresetNameFor(coordinator)), presetId)
      // M2.3 WP1a (preset-materialize waypoint): did the per-head preset FILE
      // carry the tool-secretary row? Reports the standing's contribution
      // source — a head equipped by the OWN layer (M2.3) is intentionally
      // row-independent, so this line only diagnoses the STANDING side of the
      // chain. Written to the guaranteed audit channel (the deepartments warns
      // never reach the harness stdout).
      appendToolsetAudit(stateDir, {
        wp: 'preset-materialize',
        presetId,
        toolSecretary: composition.includes('- id: tool-secretary') ? 'yes' : 'no'
      })
      ctx.logger.info(`[deepartments] per-head preset "${presetId}" materialized at ${dstDir}`)
    } catch (error: unknown) {
      ctx.logger.warn(`[deepartments] per-head preset "${presetId}" materialization skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // --- Batch G: the journal (long-term memory) + sleep lifecycle ---------------
  // A permanent head CHOOSES to persist its memory before sleeping: it writes an
  // explicit agent-authored memo to `<stateDir>/journals/<memberId>.md`
  // (dept_memo_write), then calls dept_sleep to mark the post and DISPOSE its
  // AgentHandle (context reset). On the next wake the relay cold-resumes the
  // SAME durable session (ctx.agents.resume) and wakes it. This is a dedicated
  // affordance and deliberately does NOT reuse dept_witness_write (the owner's
  // "guardado de memoria en un status o log del diario" is a head-authored
  // handoff note, not the relevo witness).

  /** Durable path of a post's long-term memory journal. */
  const journalPathFor = (memberId: string): string => path.join(stateDir, 'journals', `${memberId}.md`)

  // --- Task T1: SESSION MEMORY ARCHIVE (append-only history + one-cycle session
  // log + searchable index). Best-effort/non-fatal everywhere: a failure here
  // must NEVER fail the memo write or the sleep. The injected wake pack reads
  // ONLY the single checkpoint (journalPathFor via readWakeJournalKpi), so these
  // artifacts living under journals/archive|sessions|index.json are structurally
  // invisible to the lean wake surface (spec §Goal 1, test 5 locks this).
  //
  // Bounded serializer constants (scribe spec §4 — keep in sync with the doc).
  const MAX_TOOL_ARGS = 800
  const MAX_TOOL_RESULT = 2000
  const MAX_TEXT = 2000
  const MAX_FILE_BYTES = 512 * 1024

  /** Path of one member's append-only archive. */
  const archivePathFor = (memberId: string): string => path.join(stateDir, 'journals', 'archive', `${memberId}.md`)
  /** Path of the per-member search index. */
  const indexPathFor = (): string => path.join(stateDir, 'journals', 'index.json')
  /** Path of one member+ordinal one-cycle session log. */
  const sessionLogPathFor = (memberId: string, wakeCounter: number): string => path.join(stateDir, 'journals', 'sessions', `${memberId}-${wakeCounter}.md`)

  /** Deterministic per-write UNIQUE archive marker so interleaved appends across
   * the shared stateDir stay parseable (spec §Artifacts (a) — each
   * `=== ENTRY … ===` block stays intact even if blocks interleave). */
  const archiveUniqueSeq = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  /** Truncate a string to `max` chars, eliding the tail with `… [truncated]`. */
  const truncateText = (text: string, max: number): string =>
    text.length <= max ? text : `${text.slice(0, max)}… [truncated]`

  /** Best-effort heuristic extraction of top keyword tokens from the journal
   * summary (spec §Index schema — best-effort; absent → []). */
  const extractKeywords = (summary: string): string[] => {
    const words = (summary.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) ?? [])
      .filter((w) => !/^(the|and|for|with|this|that|from|into|were|has|had|our|their|when|what|will|been|were|over|under|about|after|before)$/i.test(w))
    return [...new Set(words)].slice(0, 12)
  }

  /** Best-effort heuristic extraction of file paths / report paths from the
   * journal summary (spec §Index schema — best-effort; absent → []). */
  const extractPaths = (summary: string): string[] => {
    const paths = [...summary.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((p) => /[/.]/.test(p))
    return [...new Set(paths)].slice(0, 12)
  }

  /** Best-effort heuristic extraction of commit-style lines from the summary
   * (spec §Index schema — best-effort; absent → []). */
  const extractCommits = (summary: string): string[] => {
    return (summary.match(/^[-*]\s*(?:feat|fix|docs|refactor|chore)\([^)]*\)[^:\n]*:.*$/gm) ?? []).slice(0, 12)
  }

  /** Reduce a DSH content block array to a single bounded text string
   * (keeps attachmentId references, never bytes / data: URIs). */
  const contentToText = (content: unknown, max: number): string => {
    if (!Array.isArray(content)) return truncateText(String(content ?? ''), max)
    const parts: string[] = []
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else if (b.type === 'image' && typeof b.attachment === 'object' && b.attachment !== null) {
        const ref = b.attachment as Record<string, unknown>
        if (ref.attachmentId !== undefined) parts.push(`[image:${String(ref.attachmentId)}]`)
      } else if (Array.isArray(b.content)) parts.push(contentToText(b.content, Number.POSITIVE_INFINITY) as string)
    }
    return truncateText(parts.join(' '), max)
  }

  /** Bounded markdown line for one session event (spec §Artifacts (b) body). */
  const serializeSessionEvent = (type: string, data: Record<string, unknown> | undefined): string | undefined => {
    if (data === undefined || typeof data !== 'object') return undefined
    switch (type) {
      case 'user/message':
        return `- **user:** ${contentToText(data.message !== undefined ? (data.message as Record<string, unknown>).content : data.content, MAX_TEXT)}`
      case 'assistant/message': {
        const message = data.message as Record<string, unknown> | undefined
        return `- **assistant:** ${contentToText(message?.content ?? data.content, MAX_TEXT)}`
      }
      case 'tool/call':
        return `- **tool** \`${truncateText(String(data.name ?? '?'), 120)}\` → *called*: ${truncateText(String(data.arguments ?? '{}'), MAX_TOOL_ARGS)}`
      case 'tool/result': {
        const ok = data.error === undefined
        const message = data.message as Record<string, unknown> | undefined
        const resultText = ok
          ? truncateText(typeof message?.content === 'string' ? message.content : JSON.stringify(data.meta ?? data.result ?? message?.content ?? ''), MAX_TOOL_RESULT)
          : `failed (${String((data.error as Record<string, unknown>)?.name ?? 'error')})`
        return `- **toolresult** → *${ok ? 'ok' : 'failed'}*: ${resultText}`
      }
      case 'turn/start':
        return `- **turn** ${String(data.turn)} start`
      case 'turn/end':
        return `- **turn** ${String(data.turn)} end (${String((data as Record<string, unknown>).reason ?? '')})`
      case 'step/start':
        return `- **step** ${String(data.turn)}.${String(data.step)} start`
      case 'step/end':
        return `- **step** ${String(data.turn)}.${String(data.step)} end`
      default:
        return undefined
    }
  }

  /** Build the bounded markdown body from a sliced event list (spec §Artifacts
   * (b) §4). Bounded by MAX_FILE_BYTES — on overflow drop chunk/step noise first,
   * then truncate the oldest tool lines, then stop. */
  const serializeSessionLog = (memberId: string, roomId: string, sessionId: string, wakeCounter: number, events: Array<{ type: string; seq: number; time: number; data: unknown }>, boundarySeq: number | undefined): string => {
    const first = events[0]
    const last = events[events.length - 1]
    const startSeq = boundarySeq !== undefined ? boundarySeq + 1 : first?.seq ?? 0
    const lines: string[] = [
      '---',
      `member: ${memberId}`,
      `room: ${roomId}`,
      `session_id: ${sessionId}`,
      `wake_counter: ${wakeCounter}`,
      `start_seq: ${startSeq}`,
      `end_seq: ${last?.seq ?? startSeq}`,
      `start_time: ${first !== undefined ? new Date(first.time).toISOString() : ''}`,
      `end_time: ${last !== undefined ? new Date(last.time).toISOString() : ''}`,
      `journal: journals/${memberId}.md`,
      '---',
      '## cycle'
    ]
    for (const event of events) {
      const line = serializeSessionEvent(event.type, (event.data ?? {}) as Record<string, unknown>)
      if (line === undefined) continue // skip assistant/chunk and unknown noise
      // Hard byte cap: drop the line rather than grow an unbounded file.
      if (lines.join('\n').length + line.length + 1 > MAX_FILE_BYTES) break
      lines.push(line)
    }
    return lines.join('\n')
  }

  /** Stub form when the transcript cannot be captured (spec §Capture flow 6):
   * frontmatter + `transcript: unavailable` + reason + pointer to the checkpoint.
   * Never throws; used so the memo write / dept_sleep still succeeds. */
  const buildSessionLogStub = (memberId: string, roomId: string, sessionId: string, wakeCounter: number, reason: string): string =>
    [
      '---',
      `member: ${memberId}`,
      `room: ${roomId}`,
      `session_id: ${sessionId}`,
      `wake_counter: ${wakeCounter}`,
      'transcript: unavailable',
      `reason: ${reason}`,
      `journal: journals/${memberId}.md`,
      '---',
      '## cycle',
      `No DSH transcript captured for this cycle (reason: ${reason}). Journal checkpoint follows at journals/${memberId}.md.`
    ].join('\n')

  /** Best-effort heuristic population of the mutable search index fields from
   * the checkpoint text/summary (spec §Index schema — best-effort; absent → []).
   * The AUTHORITATIVE fields (timestamp/wake_counter/session_log_path/archive_seq)
   * are always set. */
  const deriveIndexEntry = (memberId: string, content: string, wakeCounter: number, archiveSeq: string): {
    timestamp: string; wake_counter: number; current_step?: string; keywords: string[];
    files_touched: string[]; commits: string[]; open_items: string[]; report_paths: string[];
    session_log_path: string; archive_seq: string
  } => {
    const tsMatch = content.match(/^timestamp:\s*(.+)$/m)
    const stepMatch = content.match(/^current_step:\s*(.+)$/m)
    const openMatch = content.match(/^open_items:\s*(\[.*\])$/m)
    let openItems: string[] = []
    if (openMatch !== null) {
      try {
        const parsed = JSON.parse(openMatch[1]) as unknown
        if (Array.isArray(parsed)) openItems = parsed.filter((x): x is string => typeof x === 'string')
      } catch { /* keep [] */ }
    }
    const summary = content.replace(/^---$[\s\S]*?^---$/m, '').replace(/^wake routine:.*$/m, '').trim()
    const filesTouched = extractPaths(summary)
    const reportPaths = filesTouched.filter((p) => p.includes('.dsh/reports/') || p.startsWith('.dsh/'))
    const entry: {
      timestamp: string; wake_counter: number; current_step?: string; keywords: string[];
      files_touched: string[]; commits: string[]; open_items: string[]; report_paths: string[];
      session_log_path: string; archive_seq: string
    } = {
      timestamp: tsMatch !== null ? tsMatch[1].trim() : new Date().toISOString(),
      wake_counter: wakeCounter,
      keywords: extractKeywords(summary),
      files_touched: filesTouched,
      commits: extractCommits(summary),
      open_items: openItems,
      report_paths: reportPaths,
      // Durable, machine-readable citation (relative to the stateDir).
      session_log_path: `journals/sessions/${memberId}-${wakeCounter}.md`,
      archive_seq: archiveSeq
    }
    if (stepMatch !== null) entry.current_step = stepMatch[1].trim()
    return entry
  }

  /** Local-time marker fragment for the archive delimiter (`ts=`). */
  const archiveLocalTs = (): string => {
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  /** Task T1 — capture the ONE-CYCLE session log (WAKE→memo) for a member's
   * current cycle and write it bounded to `journals/sessions/<memberId>-<wake_counter>.md`
   * (atomic tmp+rename). Slices by exact event `seq > boundarySeq` (the seq
   * persisted at the previous dept_sleep), falling back to `event.time > lastWakeMs`
   * (from the prior journal's `last_wake`) for the first-ever cycle. BEST-EFFORT:
   * on ANY failure writes the STUB form and warns — never throws into the memo
   * write or sleep. Returns the session-log path (real or stub). */
  const captureSessionLog = async (memberId: string, roomId: string, sessionId: string, wakeCounter: number, boundarySeq: number | undefined): Promise<string> => {
    const logPath = sessionLogPathFor(memberId, wakeCounter)
    const journalPath = journalPathFor(memberId)
    try {
      // 1. Flush the live session's in-memory tail so readRaw reflects it
      //    (mirrors flushLiveSessionLog, session-export.js:95-101). Invoke the
      //    real service methods as BOUND method calls — `this` must survive:
      //    dsh-session's `flush(session)` reads `this.liveEntryFor(session)`
      //    (dsh-session lib/index.js:1792, rc.8) and the jsonl backend's
      //    `readRaw(id)` reads `this.findLog(...)` (dsh-session-persistence-jsonl
      //    lib/index.js:869). The earlier extraction-then-call form
      //    (`const f = sessions.flush; await f(live)`) lost `this` and crashed
      //    live captures with `Cannot read properties of undefined (reading
      //    'liveEntryFor')` — every live session log degraded to the stub
      //    (Batch S1 in-the-wild fix; spec §Capture flow 2 documents the bound
      //    `ctx.get('sessions').flush(session)` shape).
      const sessions = ctx.get('sessions') as { get?: (id: string) => unknown; flush?: (session: unknown) => Promise<unknown> } | undefined
      if (sessions !== undefined && sessionId !== undefined) {
        const live = sessions.get?.(SessionId(sessionId))
        if (live !== undefined && typeof sessions.flush === 'function') await sessions.flush(live)
      }
      // 2. In-process read of the durable JSONL artifact (readRaw).
      const persistence = ctx.get('sessionPersistence') as { readRaw?: (id: SessionId, signal?: AbortSignal) => Promise<{ content: string } | undefined> } | undefined
      if (persistence === undefined || typeof persistence.readRaw !== 'function') {
        throw new Error('sessionPersistence unavailable (no readRaw)')
      }
      const raw = await persistence.readRaw(SessionId(sessionId))
      if (raw === undefined || typeof raw.content !== 'string' || raw.content === '') {
        throw new Error('no stored session artifact (readRaw returned nothing)')
      }
      // 3. Parse the JSONL events (skipping malformed/noise lines defensively).
      const events: Array<{ type: string; seq: number; time: number; data: unknown }> = []
      for (const line of raw.content.split('\n')) {
        if (line.trim() === '') continue
        try {
          const ev = JSON.parse(line) as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
          if (ev !== null && typeof ev === 'object' && typeof ev.type === 'string' && typeof ev.seq === 'number' && typeof ev.time === 'number') {
            events.push({ type: ev.type, seq: ev.seq, time: ev.time, data: ev.data })
          }
        } catch { /* skip malformed line */ }
      }
      // 4. Slice one cycle: exact by seq, else by time from the prior journal.
      let lastWakeMs: number | undefined
      if (boundarySeq === undefined) {
        try {
          const prior = await readFile(journalPath, 'utf8')
          const m = prior.match(/^last_wake:\s*(.+)$/m)
          if (m !== null) { const t = Date.parse(m[1].trim()); if (!Number.isNaN(t)) lastWakeMs = t }
        } catch { /* no prior journal → include whole log */ }
      }
      const sliced = events.filter((ev) =>
        boundarySeq !== undefined ? ev.seq > boundarySeq
          : lastWakeMs !== undefined ? ev.time > lastWakeMs
            : true)
      const markdown = serializeSessionLog(memberId, roomId, sessionId, wakeCounter, sliced, boundarySeq)
      // 5. Atomic write (tmp+rename).
      const tmpPath = `${logPath}.tmp`
      await mkdir(path.dirname(logPath), { recursive: true })
      await writeFile(tmpPath, markdown, 'utf8')
      await rename(tmpPath, logPath)
      return logPath
    } catch (error) {
      // 6. Best-effort: stub form + warn; never throw.
      const reason = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn(`[deepartments] session log capture skipped: ${reason}`)
      const markdown = buildSessionLogStub(memberId, roomId, sessionId, wakeCounter, reason)
      try {
        const tmpPath = `${logPath}.tmp`
        await mkdir(path.dirname(logPath), { recursive: true })
        await writeFile(tmpPath, markdown, 'utf8')
        await rename(tmpPath, logPath)
      } catch { /* give up silently on the stub write — never throw */ }
      return logPath
    }
  }

  /** Task T1 — append a member's full journal entry to the append-only archive
   * `journals/archive/<memberId>.md` (per-write unique delimiter so interleaved
   * appends across the shared stateDir stay parseable) and rewrite the mutable
   * `journals/index.json` atomically (last-write-wins, documented acceptable).
   * BEST-EFFORT/NON-FATAL: a throw here must not fail the memo write or sleep.
   * Returns the archive marker line. `exec` is accepted for signature stability
   * (the spec's helper contract) but is not consumed. */
  const archiveJournalEntry = async (memberId: string, roomId: string, _ctx: unknown, _exec: unknown, opts: { checkpointText: string; wakeCounter: number; lastWakeMs?: number; boundarySeq?: number; archiveSeq?: string }): Promise<string> => {
    const marker = opts.archiveSeq ?? `=== ENTRY ts=${archiveLocalTs()} wake_counter=${opts.wakeCounter} seq=${archiveUniqueSeq()} ===`
    const block = [marker, opts.checkpointText, '=== END ENTRY ===', ''].join('\n')
    const archivePath = archivePathFor(memberId)
    await mkdir(path.dirname(archivePath), { recursive: true })
    await appendFile(archivePath, block, 'utf8')
    // Rewrite the per-member search index atomically (last-write-wins).
    const entry = deriveIndexEntry(memberId, opts.checkpointText, opts.wakeCounter, marker)
    const indexPath = indexPathFor()
    let existing: unknown
    try { existing = JSON.parse(await readFile(indexPath, 'utf8')) } catch { existing = undefined }
    const index: { version: number; members: Record<string, { entries: unknown[] }> } =
      existing !== undefined && typeof existing === 'object' && (existing as { version?: unknown }).version === 1
        ? existing as { version: number; members: Record<string, { entries: unknown[] }> }
        : { version: 1, members: {} }
    if (index.members === undefined || index.members === null || typeof index.members !== 'object') index.members = {}
    if (index.members[memberId] === undefined) index.members[memberId] = { entries: [] }
    index.members[memberId].entries.push(entry)
    const tmpPath = `${indexPath}.tmp`
    await mkdir(path.dirname(indexPath), { recursive: true })
    await writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf8')
    await rename(tmpPath, indexPath)
    return marker
  }

  /** Task T1 — the SHARED best-effort checkpoint hook: capture the one-cycle
   * session log (when a live session id is known) and archive the entry, invoked
   * from writeJournal and the bump* siblings after their atomic commit. The
   * capture and the archive are INDEPENDENTLY best-effort — a failure in either
   * must NEVER fail the memo write or sleep, and a capture failure must not
   * skip the archive (spec §Capture flow — "always let writeJournal's memo
   * commit proceed"). Warns on failure; never throws. */
  const archiveCycle = async (memberId: string, roomId: string, sessionId: string | undefined, wakeCounter: number, checkpointText: string, boundarySeq: number | undefined, lastWakeMs: number | undefined, archiveSeq?: string): Promise<void> => {
    if (sessionId !== undefined) {
      try {
        await captureSessionLog(memberId, roomId, sessionId, wakeCounter, boundarySeq)
      } catch (error) {
        ctx.logger?.warn(`[deepartments] session log capture failed despite fallback: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      await archiveJournalEntry(memberId, roomId, undefined, undefined, { checkpointText, wakeCounter, lastWakeMs, boundarySeq, ...(archiveSeq !== undefined ? { archiveSeq } : {}) })
    } catch (error) {
      ctx.logger?.warn(`[deepartments] journal archive skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Write the journal file (author/room/timestamp/wake_counter/last_wake/
   * board_cursor frontmatter + runs of decisions/constraints/openItems +
   * optional current_step + the free-form summary body, closing with a short
   * wake-routine footer). Returns the durable memo path.
   *
   * wake_counter semantics — now UNIFORM across hosts and registered posts
   * (heads + workers, 2026-08-20 parity): the counter is the ORDINAL of the
   * current awake session and ADVANCES ONLY AT dept_sleep (see
   * bumpHostSleepCounter / bumpPostSleepCounter), never at write — so a second
   * dept_memo_write within one awake session keeps the SAME ordinal (first-ever
   * → 1, later → the current value). The +1 at the seed boundary happens in the
   * sleep layer, giving hosts, heads and workers identical ordinal semantics. */
  const writeJournal = async (memberId: string, roomId: string, summary: string, decisions: string[], constraints: string[], openItems: string[], currentStep?: string, archive?: { sessionId?: string; wakeCounter?: number; archiveSeq?: string; lastWakeMs?: number; boundarySeq?: number }): Promise<string> => {
    // Batch W2 identity + cursor block: derive the counter and the boundary the
    // previous incarnation left at from the PRIOR journal so a re-materialized
    // head/Asistente can verify its state on wake (lost-cursor / stale
    // detection). ENOENT-tolerant: a first-ever write has no prior journal →
    // wake_counter 1, last_wake none. The counter is NEVER advanced by the
    // write itself (for hosts, heads AND workers indistinguishably — parity):
    // the ordinal increments only at the dept_sleep seed boundary via
    // bumpHostSleepCounter / bumpPostSleepCounter.
    let prevCounter = 0
    let prevTimestamp: string | undefined
    try {
      const prior = await readFile(journalPathFor(memberId), 'utf8')
      const counterMatch = prior.match(/^wake_counter:\s*(\d+)/m)
      if (counterMatch !== null) prevCounter = Number(counterMatch[1])
      const tsMatch = prior.match(/^timestamp:\s*(.+)$/m)
      if (tsMatch !== null) prevTimestamp = tsMatch[1].trim()
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const wakeCounter = archive?.wakeCounter ?? Math.max(prevCounter, 1)
    // Task T1 — the journal entry cites BOTH archive artifacts (additive
    // frontmatter lines after `open_items:`/before the closing `---`; the KPI
    // regex anchors `^wake_counter:` and `^open_items:` per-line, so extra later
    // lines are safe — spec §Journal-body citation). The archive marker is
    // precomputed here so the checkpoint can cite the exact fence that the
    // post-commit append will write.
    const archiveFence = archive?.archiveSeq ?? `=== ENTRY ts=${archiveLocalTs()} wake_counter=${wakeCounter} seq=${archiveUniqueSeq()} ===`
    const sessionLogCite = `journals/sessions/${memberId}-${wakeCounter}.md`
    const content = [
      '---',
      `author: ${memberId}`,
      `room: ${roomId}`,
      `timestamp: ${new Date().toISOString()}`,
      `wake_counter: ${wakeCounter}`,
      `last_wake: ${prevTimestamp ?? 'none'}`,
      ...(currentStep !== undefined ? [`current_step: ${currentStep}`] : []),
      // B3 cutover: board read-cursors are gone — the informational frontmatter
      // line stays for journal-schema stability, pinned to 'none'.
      'board_cursor: none',
      `decisions: ${yamlList(decisions)}`,
      `constraints: ${yamlList(constraints)}`,
      `open_items: ${yamlList(openItems)}`,
      `archive_seq: ${archiveFence}`,
      `session_log: ${sessionLogCite}`,
      '---',
      '',
      summary,
      '',
      // Batch C — P1 routine-footer dedupe: the journal footer is now a ONE-LINE
      // pointer to the canonical wake routine instead of embedding the full
      // HOST_WAKE_ROUTINE_TEXT (~620 bytes). The canonical text still comes in
      // ONCE per wake via wake-pack section 9 (buildWakePack, ~651) and via the
      // full skill body the pack embeds — so dropping it from the footer here
      // kills ~1/3 of the per-wake routine redundancy without touching the const,
      // the skill file, or the pack's §9.
      'wake routine: see skill \'Wake routine (injected wake)\''
    ].join('\n')
    const memoPath = journalPathFor(memberId)
    await mkdir(path.dirname(memoPath), { recursive: true })
    // Atomic write: write to a sibling temp path on the same filesystem, then
    // rename over the target. A crash mid-write must never leave a truncated
    // journal, because the journal is the next wake's ONLY durable surface.
    const tmpPath = `${memoPath}.tmp`
    try {
      await writeFile(tmpPath, content, 'utf8')
      await rename(tmpPath, memoPath)
    } catch (error: unknown) {
      // Best-effort cleanup of the temp file; ignore cleanup errors.
      try { await unlink(tmpPath) } catch { /* ignore */ }
      throw error
    }
    // Task T1 — AFTER the checkpoint commit, archive this entry + capture the
    // one-cycle session log (best-effort/non-fatal; a failure must NOT fail the
    // memo write). Runs only when a live session id is supplied (the memo tool
    // passes the calling agent's durable id).
    if (archive?.sessionId !== undefined) {
      const boundarySeq = archive.boundarySeq ?? hosts.get(memberId)?.boundarySeq ?? byPost.get(memberId)?.boundarySeq
      const lastWakeMs = archive.lastWakeMs ?? (prevTimestamp !== undefined ? Date.parse(prevTimestamp) : undefined)
      await archiveCycle(memberId, roomId, archive.sessionId, wakeCounter, content, boundarySeq, lastWakeMs, archiveFence)
    }
    return memoPath
  }

  /** Advance a HOST journal's `wake_counter` by exactly 1 at the dept_sleep
   * boundary and persist atomically to `<stateDir>/journals/<memberId>.md`
   * (same tmp+rename pattern as writeJournal) — a PURE counter bump: the base
   * author/room/timestamp/last_wake/current_step/board_cursor frontmatter and
   * the body are left UNTOUCHED. Returns the NEW full content string (the
   * dept_sleep host path seeds the live surface's reset from this), so the
   * next wake's fresh context already reflects the incremented ordinal before
   * the just-completed sleep. Throws loudly if the journal has no
   * `wake_counter:` frontmatter line (malformed journal). */
  const bumpHostSleepCounter = async (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }): Promise<string> => {
    const counterLine = content.match(/^wake_counter:\s*(\d+)$/m)
    if (counterLine === null) {
      throw new Error(`[deepartments] bumpHostSleepCounter: journal for ${memberId} has no "wake_counter:" frontmatter line — cannot advance the wake ordinal`)
    }
    const bumpedWake = Number(counterLine[1]) + 1
    const bumped = content.replace(/^wake_counter:\s*\d+$/m, `wake_counter: ${bumpedWake}`)
    const memoPath = journalPathFor(memberId)
    const tmpPath = `${memoPath}.tmp`
    try {
      await writeFile(tmpPath, bumped, 'utf8')
      await rename(tmpPath, memoPath)
    } catch (error: unknown) {
      // Best-effort cleanup of the temp file; ignore cleanup errors.
      try { await unlink(tmpPath) } catch { /* ignore */ }
      throw error
    }
    // Task T1 — AFTER the sleep-boundary commit, archive the bumped entry +
    // capture the just-ended cycle's session log (best-effort/non-fatal).
    if (archive?.sessionId !== undefined) {
      const boundarySeq = archive.boundarySeq ?? hosts.get(memberId)?.boundarySeq
      let lastWakeMs: number | undefined
      const lw = bumped.match(/^last_wake:\s*(.+)$/m)
      if (lw !== null) { const t = Date.parse(lw[1].trim()); if (!Number.isNaN(t)) lastWakeMs = t }
      await archiveCycle(memberId, archive.roomId ?? 'board', archive.sessionId, bumpedWake, bumped, boundarySeq, lastWakeMs)
    }
    return bumped
  }

  /** Advance a REGISTERED POST's (head OR worker) journal `wake_counter` by
   * exactly 1 at the dept_sleep seed boundary and persist atomically — the
   * post/worker analogue of bumpHostSleepCounter, giving heads + workers the
   * SAME ordinal semantics as the host (the counter advances ONLY here at
   * sleep, never on a plain write; see writeJournal). Pure counter bump: the
   * base author/room/timestamp/last_wake/current_step/board_cursor frontmatter
   * and the body are left UNTOUCHED. Returns the NEW full content string.
   * Throws loudly if the journal has no `wake_counter:` frontmatter line. */
  const bumpPostSleepCounter = async (memberId: string, content: string, archive?: { sessionId?: string; roomId?: string; boundarySeq?: number }): Promise<string> => {
    const counterLine = content.match(/^wake_counter:\s*(\d+)$/m)
    if (counterLine === null) {
      throw new Error(`[deepartments] bumpPostSleepCounter: journal for ${memberId} has no "wake_counter:" frontmatter line — cannot advance the wake ordinal`)
    }
    const bumpedWake = Number(counterLine[1]) + 1
    const bumped = content.replace(/^wake_counter:\s*\d+$/m, `wake_counter: ${bumpedWake}`)
    const memoPath = journalPathFor(memberId)
    const tmpPath = `${memoPath}.tmp`
    try {
      await writeFile(tmpPath, bumped, 'utf8')
      await rename(tmpPath, memoPath)
    } catch (error: unknown) {
      // Best-effort cleanup of the temp file; ignore cleanup errors.
      try { await unlink(tmpPath) } catch { /* ignore */ }
      throw error
    }
    // Task T1 — AFTER the sleep-boundary commit, archive the bumped entry +
    // capture the just-ended cycle's session log (best-effort/non-fatal).
    if (archive?.sessionId !== undefined) {
      const boundarySeq = archive.boundarySeq ?? byPost.get(memberId)?.boundarySeq
      let lastWakeMs: number | undefined
      const lw = bumped.match(/^last_wake:\s*(.+)$/m)
      if (lw !== null) { const t = Date.parse(lw[1].trim()); if (!Number.isNaN(t)) lastWakeMs = t }
      await archiveCycle(memberId, archive.roomId ?? 'board', archive.sessionId, bumpedWake, bumped, boundarySeq, lastWakeMs)
    }
    return bumped
  }

  /** Read a post's journal (undefined when absent). */
  const readJournal = async (memberId: string): Promise<string | undefined> => {
    try {
      return await readFile(journalPathFor(memberId), 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** The configured coordinator (for persona/agentOptions) of a postId, if any.
   * Not every resident post maps to a configured department (a postId is usually
   * a coordinator, but the lifecycle should not hard-depend on one). */
  const coordinatorForPost = (postId: string): CoordinatorConfig | undefined => {
    for (const department of org.departments) {
      if (department.coordinator?.postId === postId) return department.coordinator
    }
    return undefined
  }

  /** The CONFIG DEPARTMENT of a registered post, if its coordinator matches
   * (F1). A configured HEAD derives its department here; a WORKER carries the
   * link durably in its own entry (recorded at create from the creating head's
   * department — `departmentForPost(creatorId)`) and has no config row.
   * Undefined = not a configured head (a worker, or a legacy/non-config post). */
  const departmentForPost = (postId: string): DepartmentConfig | undefined => {
    for (const department of org.departments) {
      if (department.coordinator?.postId === postId) return department
    }
    return undefined
  }

  /** The CONFIG DEPARTMENT of a catalog entry (F5, spec 004 §6.2): a worker
   * carries its link durably (`entry.departmentId` — recorded at create from
   * the creating head's department); a configured head derives it from config
   * (`departmentForPost`). A worker whose departmentId no longer exists in
   * config (a removed department), OR a legacy pre-F1 worker (no departmentId),
   * yields undefined → the caller falls back to the shared workspace root
   * (compat — the session keeps its cwd; a fresh create uses the root). */
  const departmentForEntry = (entry: PostEntry): DepartmentConfig | undefined => {
    if (entry.departmentId !== void 0) {
      const byId = org.departments.find((d) => d.id === entry.departmentId)
      if (byId !== void 0) return byId
    }
    return departmentForPost(entry.postId)
  }

  // FASE 2 step (e): the NON-pure wake-pack assembly (git bearings, ROADMAP
  // tail, skill body, message delta, condensed roster, system state) + the
  // `agent/pre-step` injector now live in ./core/wakepack.js (the WAKE CONTEXT
  // PACK + ROSTER module). The apply fiber builds ONE WakePackService below and
  // injects the closure-bound deps (the catalog maps + identity resolvers + the
  // deferred sleep surface replace + the W8-d heartbeat assembly). Only the
  // W8-d heartbeat assembly (the health section) remains here — it is injected
  // into the service as a closure-bound dep.

  /** W8-d PART A — compute the `## System heartbeat:` snapshot at assembly time
   * (live reads; buildHeartbeatSection is the pure renderer). Reads the SAME
   * session event logs + inbox the W8-c watchdog uses (buildPostSnapshot /
   * readInboxByPost / scanHostWaits), so the ages are NEVER reimplemented.
   * Gated by `health.heartbeatEnabled` (default on): an explicit false → the
   * snapshot is undefined (the section is OMITTED, never a throw). ANY read
   * failure degrades to undefined (omitted section). */
  const assembleHeartbeat = (hostId: string): string | undefined => {
    const health = config.health
    if (health?.heartbeatEnabled === false) return undefined
    try {
      const nowMs = Date.now()
      const waitThresholdMs = resolveSystemWaitMs(health)
      const { inboxTsByPost, hostRowsByPost } = readInboxByPost(stateDir, hostId, nowMs, HEALTH_ERROR_WINDOW_MS)
      // HOST last-activity (the Asistente session's last logged event) — reuse
      // the same snapshot primitive with an empty inbox (only activity matters).
      const hostEntry = [...hosts.values()].find((entry) => entry.hostId === hostId)
      const hostLive = hostEntry !== undefined ? agents?.get(SessionId(hostEntry.sessionId)) : undefined
      const hostEvents = (hostLive?.session?.events ?? []) as HealthSessionEvent[]
      const hostSnap = buildPostSnapshot({ postId: hostId, events: hostEvents, inboxTs: [] })
      // Per ACTIVE (and dormant) catalog post rows + the WAIT scan inputs +
      // the W8-h INTERRUPTED (stopped) postIds.
      const rows: HeartbeatRow[] = []
      const hostWaitPosts: HostWaitPostInput[] = []
      const interruptedPostIds: string[] = []
      for (const [postId, entry] of byPost) {
        if (entry.retired === true) continue
        const live = agents?.get(SessionId(entry.sessionId))
        const events = (live?.session?.events ?? []) as HealthSessionEvent[]
        const snap = buildPostSnapshot({ postId, events, inboxTs: inboxTsByPost.get(postId) ?? [] })
        rows.push({
          postId,
          sleeping: entry.sleepEpoch !== void 0,
          ...(snap.lastActivityTs !== undefined ? { lastActivityTs: snap.lastActivityTs } : {}),
          pendingCount: snap.pendingCount,
          ...(snap.oldestPendingTs !== undefined ? { oldestPendingTs: snap.oldestPendingTs } : {})
        })
        hostWaitPosts.push({ postId, retired: false, events, hostMessages: hostRowsByPost.get(postId) ?? [], sleeping: entry.sleepEpoch !== void 0 })
        // W8-h — a post is INTERRUPTED (stopped) when its session ends in an
        // interrupted turn AND it is NOT a LIVE-RUNNING agent (a live running
        // turn is healthy progress, never a stop). Reuses the SAME pure detector
        // the boot reconciliation uses.
        const capture = scanInterruptedTurn(events, entry.sessionId, postId)
        if (capture !== undefined && !(live !== undefined && live.status === 'running')) {
          interruptedPostIds.push(postId)
        }
      }
      const waits = scanHostWaits(hostWaitPosts, nowMs, waitThresholdMs)
      const waitReason = waits.length > 0
        ? `host waiting on ${waits.map((wait) => wait.postId).join(', ')}: ${waits[0].error ?? 'no reply or session activity'}`
        : undefined
      return buildHeartbeatSection(
        {
          hostLastActivityTs: hostSnap.lastActivityTs,
          rows,
          ...(waitReason !== undefined ? { waitReason } : {}),
          ...(interruptedPostIds.length > 0 ? { interruptedPostIds } : {})
        },
        nowMs
      )
    } catch {
      return undefined
    }
  }

  // D3 (subagent/gui/pooler phase): the dispatch-time transient-subagent role
  // registry is now a CORE SERVICE (`deepartments.subagentRoles` — ONE
  // per-process store in dshd-core; written by src/subagent.ts at dispatch).
  // The wake-pack `roleForSession` dep READS it here, in BOTH the in-bundle
  // fallback construction and the dshd-core binder registration below, so the
  // composed and the bundle-alone paths resolve the SAME role. When the service
  // is absent (a minimal composition), fall back to the drop-in compat function
  // the role-orient bridge re-exports — the SAME store (R6, behavior-neutral:
  // `get` with the `?? 'generic'` default is exactly `roleForSession`).
  const subagentRoles = ctx.get('deepartments.subagentRoles') as SubagentRolesService | undefined
  const roleForSessionLive = subagentRoles === undefined
    ? roleForSession
    : (sessionId: string) => subagentRoles.get(sessionId) ?? 'generic'

  // FASE 2 step (e): build the ONE per-apply WakePackService (the wake-pack
  // injector + roster). The service lives in ./core/wakepack.js and owns the
  // condensed roster (`buildCondensedRoster`, which derives the ACTIVE-ONLY
  // member list from the single-source `listActiveMembers`), the pack assembly
  // (`assembleWakePack` / `assembleWakeSnapshot`) and the `agent/pre-step`
  // injector. The deps below are the closure-bound catalog maps + identity
  // resolvers + the deferred sleep surface replace + the W8-d heartbeat
  // assembly (kept in invoke.ts — health concern), mirroring registry/delivery.
  // FASE 2.5 BATCH B: consume the wakepack SERVICE from dshd-core when composed;
  // fall back to a behavior-neutral in-bundle construction + warn in a minimal
  // composition (dshd-core absent).
  const wakePackService = (ctx.get('deepartments.wakepack') as WakePackService | undefined) ?? (() => {
    ctx.logger.warn('[deepartments] dshd-core is not composed — the wakepack service is constructed in-bundle (behavior-neutral fallback).')
    return createWakePackService({
      byPost,
      hosts,
      getHost: (hostId) => hosts.get(hostId),
      postIdForChild,
      hostIdForSession,
      refreshPresence,
      wakePackInjected,
      deferredSleepReplace,
      persistHosts,
      roleForSession: roleForSessionLive,
      buildSubagentOrientation,
      // E2 — the DIRECTORIO section is assembled from the bundle's own org
      // departments (the minimal-composition fallback of the SHARED CONFIG
      // SOURCE `deepartments.org` — the dshd-core row when composed): the pack
      // never hardcodes the org chart; add/remove a department = edit config.
      // Optional slice (name + coordinator.postId + purpose/services) — a
      // legacy config without the E2 fields composes and the directory section
      // renders only what carries purpose/services (R6).
      departments: org.departments,
      computeHostSleepSurfacePlan,
      buildSleepJournalMessage,
      assembleHeartbeat,
      readPresenceStateFile,
      journalPathFor,
      // Lazy getter: the message store is opened later in applyInvoke (single-
      // process open); resolved at assembly time, never at construction.
      messagesStoreReady: () => messagesStoreReady,
      stateDir: stateDir,
      repoRoot,
      // PACING (owner m-PACING, 2026-08-28): the org.pacing.* franja config for
      // the wake-pack `## Pacing (franja)` section (the minimal-composition
      // fallback of the SHARED CONFIG SOURCE — the dshd-core lazy service
      // reads org.org.pacing; here the bundle passes its own org.pacing).
      // Absent config → the code defaults (enabled ON); enabled:false → the
      // section is omitted (the pre-pacing pack).
      pacing: org.pacing,
      logger: ctx.logger
    })
  })()
// =========================================================================
  // SURFACE RETURN — the members the rest of applyInvoke consumes at the SAME
  // positions as before the extraction: the preset materialization closures +
  // the journal/archive T1 surface (writeJournal/bump*/readJournal/
  // journalPathFor) + the coordinator/department resolvers + the W8-d
  // wake-pack assembly (assembleHeartbeat / roleForSessionLive /
  // wakePackService) + the shared constants (PRESET_ID / WORKER_PRESET_ID /
  // WORKER_AGENT_OPTIONS / HOST_AGENT_OPTIONS / resolveMaterializeAgentOptions
  // / repoRoot / dshHome / materializePreset / materializeHeadPreset). The
  // apply-fiber destructure re-binds them at the same position (spawn/tools/
  // delivery factories + the daemons + the agent/pre-step registration read
  // the SAME bindings).
  // =========================================================================
  return {
    PRESET_ID,
    WORKER_PRESET_ID,
    WORKER_AGENT_OPTIONS,
    HOST_AGENT_OPTIONS,
    resolveMaterializeAgentOptions,
    repoRoot,
    dshHome,
    materializePreset,
    materializeHeadPreset,
    journalPathFor,
    writeJournal,
    bumpHostSleepCounter,
    bumpPostSleepCounter,
    readJournal,
    coordinatorForPost,
    departmentForPost,
    departmentForEntry,
    assembleHeartbeat,
    roleForSessionLive,
    wakePackService
  }
}