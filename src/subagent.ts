// dsh-deepartments — always-async subagent delegation tool (owner decision
// 2026-08-16: subagent dispatch must NEVER block the orchestrator).
//
// A reduced fork of @deepseek-ai/dsh-tool-subagent (MIT): the same provider
// mount/dispose mechanics, provider wording and continuable path, minus the
// `run_in_background` parameter, the one-shot/background-jobs branch, and the
// enableRunInBackground/backgroundMode options. Every call starts a durable
// continuable child and returns its id immediately; there is no blocking mode
// the model can choose.
//
// NO export default (pitfall 0001 — breaks `inject`).
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
// D3 (subagent/gui/pooler phase): the dispatch-time role registry is now the
// CORE SERVICE `deepartments.subagentRoles` (one per-process store in
// dshd-core). The compat functions below are the R6 drop-in fallback (same
// store) used when the service is not reachable from this plugin's ctx (a
// minimal composition where dshd-core is absent).
import { rememberRole, forgetRole } from './role-orient.js'
import type { SubagentRolesService } from './role-orient.js'
// M2.3: the guaranteed diagnostics channel for the standing apply waypoint
// (the deepartments warns never reach stdout — the M2.2 finding).
import { appendToolsetAudit, auditStateDir } from './toolset-audit.js'

export const name = 'deepartments-subagent'
// M2.2 (deploy fix, 2026-08-28): `subagents` is NO LONGER a hard inject. The
// cordis inject names are a HARD service-availability gate: a fiber whose
// injected service is absent never executes, and dsh-agent-presets REJECTS a
// standing mount whose row sits inactive (`inactiveRows`/`mountPreset`), so a
// tool-secretary row mounted in a chain WITHOUT the subagents service (a
// department head — the host composition is the only plane that hosts it)
// would fail the WHOLE head preset mount, leaving the tool absent even though
// the registration itself has been provider-independent since M2.1. The
// service is therefore resolved OPTIONALLY, the codebase's `ctx.get(...)`
// discipline (mirrors src/index.ts / applyInvoke): at apply for the late
// provider checks, and LAZILY at execute for startContinuable, failing loud
// there with a clear absent-service error instead of never registering.
export const inject = ['tools', 'systemPrompt']

/** Prompt order after bounded delegation policy and before child reporting. */
const SUBAGENT_SECTION_ORDER = 116.5

/** Deployment policy for one always-async delegation tool instance.
 * `toolFilter.deny` (optional) excludes the named tool ids from the child's
 * catalog, and `toolFilter.allow` restricts it to the named ids — the supported
 * way to keep a transient child's surface scoped (e.g. NON-CODE/emergency
 * delegations that must never reach `edit`/bash/commit tools). */
export interface Config {
  provider: string
  toolName?: string
  agentOptions?: { provider?: string; model?: string; maxTokens?: number }
  persona?: string
  toolFilter?: { allow?: string[]; deny?: string[] }
  maxDepth?: number | 'provider-managed'
}

/** Schemastery configuration for one always-async delegation tool. */
export const Config = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
  }).default(void 0 as unknown as { provider: string; model: string; maxTokens: number }),
  persona: z.string(),
  toolFilter: z.object({
    allow: z.array(z.string()).default(void 0 as unknown as string[]),
    deny: z.array(z.string()).default(void 0 as unknown as string[])
  }).default(void 0 as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed')]).default(3)
})

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * M2 (owner decision 2026-08-28): the ONE tool deploys a personal NON-CODE
 * READ-ONLY secretary — for the HOST and for department HEADS alike. It reads
 * journals/files/reports, searches (glob/grep) and summarises; it never edits,
 * writes, runs commands, or deploys anything (internal code work always
 * belongs to the Internal Programming Department). The pre-M2 transient roles
 * (builder/reviewer/scribe/researcher) are R6-deprecated and unified into this
 * single contract via normalizeRole — no per-role wording remains.
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function providerWording(inheritsConversation: boolean) {
  if (inheritsConversation) return {
    description: 'Delegate a follow-up to your personal NON-CODE secretary that inherits this conversation: a READ-ONLY child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use it when the ask builds on this conversation\'s context — a follow-up review of a report, a journal summary, a search — without consuming this conversation\'s context for the work itself. It never edits, writes, runs commands, or deploys anything. Internal programming and deep code analysis are NOT delegated here: route them via send_message to internal-programming-head. You receive its result, not its intermediate steps.',
    promptDescription: 'The follow-up request for the secretary. It already sees this conversation\'s completed turns, so build on them freely and state only what is new.'
  }
  return {
    description: 'Deploy your personal NON-CODE secretary: a separate READ-ONLY child agent that reads files, reports and journals, searches (glob/grep) and summarises for you — e.g. "read my journal at <path> and summarise the open items" — without consuming this conversation\'s context. It never edits, writes, runs commands, or deploys anything. Internal programming and deep code analysis are NOT delegated here: they belong to the Internal Programming Department — route them with ONE send_message to internal-programming-head. The secretary returns its result (a concise summary), not its intermediate steps. Give it a complete, standalone prompt: it does not see this conversation.',
    promptDescription: 'The complete, self-contained request for the secretary — what to read/search/summarise (path + ask). It does not share this conversation\'s context, so include everything it needs.'
  }
}

/** The fixed always-background suffix appended to every tool description. */
const ALWAYS_BACKGROUND_SUFFIX = ' This tool ALWAYS runs in the background: it immediately returns a durable subagent id and never blocks you. When the run settles, the runtime sends you a notice containing its outcome and any final assistant message; `send_message` starts a later turn in the same child conversation.'

// M2.3 (owner decision 2026-08-28) — the SECRETARY DEPLOYMENT CONTRACT as ONE
// exported source of truth. The `tool-secretary` preset row
// (presets/deepartments-head/agent.cordis.yml) and the head OWN-LAYER
// registration (src/invoke.ts installHeadBoardTools) both build the SAME tool
// through the shared `createSecretaryTool` factory, so person/toolFilter/wording
// can never diverge between the host plane (standing row) and a department head
// (own layer — the M2.3 registry that makes the tool immune to the standing
// mask). The preset row mirrors these literal values; test M2.3 asserts
// fila==constante to lock the mirror.
// D5 (modularization, 2026-08-29): this plugin surface (`deepartments-subagent`,
// subpath `./subagent`) is a FORMAL surface of the bundle — the ONE formal
// Cordis row is the `tool-secretary` row of the deepartments-head preset (see
// its SURFACE-FORMAL comment); the headless dev profile's tool-subagent-test/
// -fork rows mount the SAME plugin `dsh-deepartments/subagent` as the retained
// dev twin (R6: nothing retired). Nothing here is 'temporal/smoke' anymore.

/** The ONE secretary tool name (the single toolName, host + head). */
export const SECRETARY_TOOL_NAME = 'secretary'
/** The ONE secretary provider (the shipped head rows are `spawn`; the provider
 * is resolved at EXECUTE time — M2.1/M2.2 lazy, never at registration). */
export const SECRETARY_PROVIDER = 'spawn'
/** The ONE secretary persona (a personal NON-CODE READ-ONLY secretary) —
 * mirrors the `tool-secretary` row's folded `persona` verbatim. */
export const SECRETARY_PERSONA =
  'You are a personal NON-CODE secretary in the Deepartments organization (DeepSeek Harness): you READ files, reports and journals, SEARCH (glob/grep) and SUMMARISE for the agent that deployed you. You never edit, write, run commands, or deploy anything. Focus on journals, reports and files the deployer points you at. Internal code work and deep code analysis belong to the Internal Programming Department — never attempt them; state the limitation instead. Report your result concisely to the agent that deployed you.'
/** The ONE secretary child toolFilter: the allow whitelist is the minimal
 * inherited read-only surface; deny names only tools the child INHERITS and
 * must never expose (write + secretary itself — a secretary never deploys
 * another secretary). Mirrors the preset row's `toolFilter` verbatim. */
export const SECRETARY_TOOL_FILTER: { allow: string[]; deny: string[] } = {
  allow: ['read', 'glob', 'grep'],
  deny: ['write', SECRETARY_TOOL_NAME]
}
/** The ONE secretary maxDepth (provider-managed — the child recursion budget
 * is the provider's; no mount-time capability requirement). */
export const SECRETARY_MAX_DEPTH: 'provider-managed' = 'provider-managed'

/** The deployment config for the OWN-LAYER secretary (the head registration):
 * every field from the SECRETARY_* contract — the SAME values the preset row
 * mirrors, so the own layer and the standing row cannot drift. */
export function secretaryConfig(): Config {
  return {
    provider: SECRETARY_PROVIDER,
    toolName: SECRETARY_TOOL_NAME,
    persona: SECRETARY_PERSONA,
    toolFilter: SECRETARY_TOOL_FILTER,
    maxDepth: SECRETARY_MAX_DEPTH
  }
}

/** Build the ONE secretary delegation tool definition (the M2 contract tool
 * body — M2.3 shared factory). `apply()` registers it for the standing row and
 * `installHeadBoardTools` (invoke.ts, manager-gated) registers the SAME body on
 * the head's OWN layer, so host plane and head own layer share ONE
 * definition of the persona/toolFilter/wording. The execute is the M2.2 lazy
 * path: `ctx.get('subagents')` at CALL time, failing loud with a clear
 * absent-service error when the chain lacks the service (a department head). */
export function createSecretaryTool(ctx: Context, config: Config): ReturnType<typeof defineTool> {
  const toolName = config.toolName ?? 'subagent'
  // D3: dispatch-time role write through the core service (or the drop-in
  // compat fallback) — the execute's remember closure, resolved ONCE here so a
  // single definition carries it (role-orient is a pure bridge). The matching
  // `forget` lives in `apply()` (the subagent/end eviction handler) — the same
  // store, so a child the execute remembered is evicted when it settles.
  const roles = ctx.get('deepartments.subagentRoles') as SubagentRolesService | undefined
  const remember = roles === undefined
    ? rememberRole
    : (childSessionId: string, role: unknown) => roles.set(childSessionId, role)
  // The provider presence is resolved OPTIONALLY at build time for the wording
  // ONLY (M2.1/M2.2: registration is provider-independent; the provider is
  // resolved at EXECUTE time). maxDepth capability is validated for a provider
  // already present (fail-loud, same contract as apply).
  const subagents = ctx.get('subagents') as SubagentRuntime | undefined
  const present = subagents === void 0 ? void 0 : subagents.getProvider(config.provider)
  if (present !== void 0 && typeof config.maxDepth === 'number' && !present.capabilities.depthLimit) {
    throw new Error(`deepartments-subagent: provider "${present.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`)
  }
  const wording = providerWording(present?.inheritsParentContext === true)
  return defineTool({
      name: toolName,
      description: wording.description + ALWAYS_BACKGROUND_SUFFIX,
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.'
        },
        prompt: {
          type: 'string',
          required: true,
          description: wording.promptDescription
        },
        role: {
          type: 'string',
          description: 'Optional Deepartments contract for the child (default secretary): the ONE read-only NON-CODE role — a personal secretary that reads journal/files/reports, searches and summarises, never edits/writes/runs commands. builder|reviewer|scribe|researcher are R6-DEPRECATED and UNIFIED into secretary (normalizeRole maps them); explore is retired; unknown roles fall back to generic.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              required: true,
              const: 'continuable'
            },
            subagentId: {
              type: 'string',
              required: true
            }
          }
        },
        render: (_args, value) => [{
          type: 'text',
          text: 'started subagent ' + value.subagentId
        } as const]
      },
      isConcurrencySafe: () => true,
      async execute(args, exec): Promise<{ kind: 'continuable'; subagentId: string }> {
        const parent = exec.agent
        if (!parent) throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
        const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : void 0
        const request = {
          label: args.description,
          prompt: [{
            type: 'text',
            text: args.prompt
          } as const],
          parent,
          ...config.agentOptions !== void 0 ? { agentOptions: config.agentOptions } : {},
          ...config.persona !== void 0 ? { persona: config.persona } : {},
          ...config.toolFilter !== void 0 ? { toolFilter: config.toolFilter } : {},
          ...maxDepth !== void 0 ? { maxDepth } : {}
        }
        // The ONLY branch: start a durable continuable child and hand its id
        // back immediately. There is no blocking path — the model cannot wait
        // inline for the child even if it wanted to.
        // M2.2: the service is resolved LAZILY at call time. A secretary row
        // mounted into a standing whose chain lacks the subagents service (a
        // department head) still lands the tool in the session — invoking it
        // fails loud HERE with a clear absent-service error instead of failing
        // (or, pre-M2.2, silently never registering) at mount time. With the
        // service present, `startContinuable` resolves the named provider
        // internally and fails loud on a provider that never registered
        // (expectProvider), so the provider-side check does not need this
        // plugin's own code path.
        const subagents = ctx.get('subagents') as SubagentRuntime | undefined
        if (subagents === void 0) throw new Error(`${toolName} unavailable: subagents service absent in this session`)
        const child = await subagents.startContinuable({
          provider: config.provider,
          label: args.description,
          request,
          signal: exec.signal
        })
        // Task T4 + M2: record the dispatch-time role keyed by the child session
        // id so the pre-step injector can give THIS transient subagent a slim
        // per-role contract block instead of the full host wake pack (D3:
        // written via the `deepartments.subagentRoles` core service — see
        // src/role-orient.ts). M2 (owner decision 2026-08-28): the ONE role is
        // `secretary` — a dispatch with NO role param defaults to the secretary
        // contract (the read-only personal helper); the deprecated pre-M2 names
        // (builder/reviewer/scribe/researcher) map to it inside normalizeRole.
        // The child id is available synchronously after startContinuable; the
        // same code path serves BOTH `secretary` spawn and a context-inheriting
        // fork variant (they differ only by inheritsParentContext/mount), so
        // the role plumbing covers both automatically.
        remember(child.childId as string, args.role ?? 'secretary')
        return {
          kind: 'continuable',
          subagentId: child.childId as string
        }
      }
    })
}

export function apply(ctx: Context, config: Config) {
  if (config.maxDepth !== 'provider-managed' && config.maxDepth !== void 0) assertSubagentMaxDepth(config.maxDepth)
  if (config.toolFilter !== void 0 && config.toolFilter.allow === void 0 && config.toolFilter.deny === void 0) throw new Error('deepartments-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter')
  const toolName = config.toolName ?? 'subagent'
  // M2.3 (shared factory): the tool BODY is built by `createSecretaryTool` (the
  // ONE definition the standing row AND the head own-layer register — see
  // src/invoke.ts installHeadBoardTools). `apply()` consumes the factory and
  // keeps only the standing-specific wiring: the provider-added capability
  // check, the dispatch-role eviction, the M2.3 apply-standing waypoint and the
  // standing system-prompt section.
  ctx.tools.register(createSecretaryTool(ctx, config))
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name !== config.provider) return
    // A provider surfacing after apply is validated here (the pre-M2.1
    // mount-time throw, kept fail-loud) — the tool itself needs no
    // re-registration (M2.1 binds the NAME unconditionally; the provider is
    // resolved at execute time).
    if (typeof config.maxDepth === 'number' && !provider.capabilities.depthLimit) {
      throw new Error(`deepartments-subagent: provider "${provider.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`)
    }
  })
  // Task T4 follow-up: evict the dispatch-time role from the in-process
  // roleRegistry the moment a child settles, so the map stays bounded by
  // in-flight children (no unbounded global mutable state, AGENTS.md rule 4).
  // D3: the eviction goes through the `deepartments.subagentRoles` core service
  // (delete semantics — a superset of remember: silently no-ops in the
  // malformed-payload branch). Registered ONCE here at module scope inside
  // `apply` — NOT on any provider-mount path, which would double-register for
  // the two mounted providers. The payload's `id` is the child session id —
  // the exact key the factory's `rememberRole` wrote. Guard on `typeof id ===
  // 'string'` and never throw: an unexpected payload shape is a silent no-op (a
  // malformed edge must not break settlement teardown). The roles store is the
  // same resolution the factory performed for its execute closures (both read
  // the SAME `deepartments.subagentRoles` service / compat fallback).
  const roles = ctx.get('deepartments.subagentRoles') as SubagentRolesService | undefined
  const forget = roles === undefined
    ? forgetRole
    : (childSessionId: string) => roles.delete(childSessionId)
  ctx.on('subagent/end', (payload) => {
    const id = (payload as { id?: unknown } | undefined)?.id
    if (typeof id === 'string') forget(id)
  })
  // M2.3 WP4 (apply-standing waypoint): ONE info/audit line per standing apply
  // — whether this standing's apply saw the subagents SERVICE and the named
  // PROVIDER (the service/provider facts a head's secretary chain depends on).
  // Written to the GUARANTEED audit channel `<stateDir>/toolset-audit.jsonl`
  // (the deepartments warns never reach stdout — the M2.2 finding) in addition
  // to the logger, and it REPLACES/extends the pre-M2.3 "provider not
  // registered yet" info below with the same presence signal.
  const subagents = ctx.get('subagents') as SubagentRuntime | undefined
  const present = subagents === void 0 ? void 0 : subagents.getProvider(config.provider)
  appendToolsetAudit(auditStateDir(ctx), { wp: 'apply-standing', tool: toolName, subagents: subagents === void 0 ? 'absent' : 'present', provider: present?.name ?? 'absent' })
  if (present === void 0) {
    ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${toolName}" tool is bound anyway and resolves the provider at execute time`)
  }
  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: SUBAGENT_SECTION_ORDER,
    text: (context: AssembleContext) => ctx.tools.get(toolName, context.scope) === void 0 ? '' : `Use ${toolName} ALWAYS in the background — it has no blocking mode. Start independent delegations together in one assistant message and continue useful work while they run. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message; continue dependent work only when that notice arrives. Use send_message to give a child follow-up work. Never wait inline for a subagent; never busy-poll.`
  })
}
