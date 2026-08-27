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

export function apply(ctx: Context, config: Config) {
  if (config.maxDepth !== 'provider-managed' && config.maxDepth !== void 0) assertSubagentMaxDepth(config.maxDepth)
  if (config.toolFilter !== void 0 && config.toolFilter.allow === void 0 && config.toolFilter.deny === void 0) throw new Error('deepartments-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter')
  const toolName = config.toolName ?? 'subagent'
  // D3: WRITE the dispatch-time role through the core service
  // (`deepartments.subagentRoles` — ONE per-process store in dshd-core) so the
  // wakepack pre-step reader can never split onto a second registry. When the
  // service is unreachable (a minimal composition / a plugin ctx without the
  // dshd-core row), fall back to the drop-in compat functions the role-orient
  // bridge re-exports — they run the SAME service semantics over the SAME
  // store (R6, behavior-neutral).
  const roles = ctx.get('deepartments.subagentRoles') as SubagentRolesService | undefined
  const remember = roles === undefined
    ? rememberRole
    : (childSessionId: string, role: unknown) => roles.set(childSessionId, role)
  const forget = roles === undefined
    ? forgetRole
    : (childSessionId: string) => roles.delete(childSessionId)
  // M2.1 (deploy fix, 2026-08-28): the delegation tool is registered
  // UNCONDITIONALLY at apply time. Pre-M2.1 the registration was gated on the
  // subagent provider being resolvable at apply (sync mount) or on a later
  // `subagent/provider-added` event — a standing preset mount that applied the
  // row while the provider was absent left the tool missing at the postSetup
  // probe's FIRST read (invoke.ts HEAD_BASE_TOOLS allow-list), and the
  // restrict({allow}) then masked the inherited contribution PERMANENTLY for
  // that incarnation (the M2.1 deploy finding: a rematerialized department head
  // never saw its own `secretary`, while the host — whose provider is already
  // hot at composition time — did). The fix: the row ALWAYS leaves the tool
  // bound under `toolName` in the standing mount, so the probe always finds it
  // and the allow-list keeps it; the provider is resolved at EXECUTE time
  // (startContinuable by name — expectProvider fails loud on a missing
  // provider), never at registration. Plugin semantics are unchanged: always-
  // async continuable dispatch, agentOptions heredity, dispatch-time role
  // registry + eviction, and the system-prompt section. The provider-dependent
  // facts still validated at registration are: (a) the maxDepth depthLimit
  // capability — checked synchronously when the provider is present at apply,
  // else when it registers later (provider-added, same fail-loud throw); and
  // (b) the inheritsParentContext wording — taken from the present provider,
  // or the fresh-spawn wording while it is absent (the shipped head rows are
  // `spawn`; the host's fork row mounts with its provider already present, so
  // the fallback never mislabels a fork).
  // M2.2 (deploy fix continuation): resolve the subagents service OPTIONALLY.
  // When the service is absent from this chain (a department head — the host
  // composition hosts it, a head chain does not), `present` stays undefined and
  // the tool is registered UNCONDITIONALLY anyway (the M2.1 principle extended
  // to the SERVICE); the provider and the service are both resolved at EXECUTE
  // time with fail-loud errors, never at registration. The read goes through
  // `ctx.get` — a bare `ctx.subagents` property read on an undeclared missing
  // service would THROW (cordis inline-inject guard), which is exactly the
  // hard dependency this fix removes.
  const subagents = ctx.get('subagents') as SubagentRuntime | undefined
  const present = subagents === void 0 ? void 0 : subagents.getProvider(config.provider)
  if (present !== void 0 && typeof config.maxDepth === 'number' && !present.capabilities.depthLimit) {
    throw new Error(`deepartments-subagent: provider "${present.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`)
  }
  const wording = providerWording(present?.inheritsParentContext === true)
  ctx.tools.register(defineTool({
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
    }))
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
  // the exact key `rememberRole` wrote. Guard on `typeof id === 'string'` and
  // never throw: an unexpected payload shape is a silent no-op (a malformed
  // edge must not break settlement teardown).
  ctx.on('subagent/end', (payload) => {
    const id = (payload as { id?: unknown } | undefined)?.id
    if (typeof id === 'string') forget(id)
  })
  if (present === void 0) {
    ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${toolName}" tool is bound anyway and resolves the provider at execute time`)
  }
  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: SUBAGENT_SECTION_ORDER,
    text: (context: AssembleContext) => ctx.tools.get(toolName, context.scope) === void 0 ? '' : `Use ${toolName} ALWAYS in the background — it has no blocking mode. Start independent delegations together in one assistant message and continue useful work while they run. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message; continue dependent work only when that notice arrives. Use send_message to give a child follow-up work. Never wait inline for a subagent; never busy-poll.`
  })
}
