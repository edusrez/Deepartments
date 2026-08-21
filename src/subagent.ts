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
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { rememberRole } from './role-orient.js'

export const name = 'deepartments-subagent'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Prompt order after bounded delegation policy and before child reporting. */
const SUBAGENT_SECTION_ORDER = 116.5

/** Deployment policy for one always-async delegation tool instance. */
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
    description: 'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use this when the subtask builds on this conversation\'s context — a follow-up analysis, a review, a continuation — without consuming this conversation\'s context for the work itself. You receive its result, not its intermediate steps.',
    promptDescription: 'The task for the subagent. It already sees this conversation\'s completed turns, so build on them freely and state only what is new.'
  }
  return {
    description: 'Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation\'s context. The subagent returns its result, not its intermediate steps. Give it a complete, standalone prompt: it does not see this conversation.',
    promptDescription: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.'
  }
}

/** The fixed always-background suffix appended to every tool description. */
const ALWAYS_BACKGROUND_SUFFIX = ' This tool ALWAYS runs in the background: it immediately returns a durable subagent id and never blocks you. When the run settles, the runtime sends you a notice containing its outcome and any final assistant message; `send_message` starts a later turn in the same child conversation.'

export function apply(ctx: Context, config: Config) {
  if (config.maxDepth !== 'provider-managed' && config.maxDepth !== void 0) assertSubagentMaxDepth(config.maxDepth)
  if (config.toolFilter !== void 0 && config.toolFilter.allow === void 0 && config.toolFilter.deny === void 0) throw new Error('deepartments-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter')
  const toolName = config.toolName ?? 'subagent'
  let disposeTool: (() => void) | undefined
  const mount = (provider: { name: string; capabilities: { depthLimit: boolean }; inheritsParentContext: boolean }) => {
    if (typeof config.maxDepth === 'number' && !provider.capabilities.depthLimit) throw new Error(`deepartments-subagent: provider "${provider.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`)
    const wording = providerWording(provider.inheritsParentContext)
    disposeTool = ctx.tools.register(defineTool({
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
          description: 'Optional Deepartments role for the child (builder|reviewer|researcher|scribe|explore; default generic). Drives the slim role-contract context injection instead of the full host wake pack; unknown roles fall back to generic.'
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
        const child = await ctx.subagents.startContinuable({
          provider: config.provider,
          label: args.description,
          request,
          signal: exec.signal
        })
        // Task T4: record the dispatch-time role keyed by the child session id so
        // the pre-step injector can give THIS transient subagent a slim per-role
        // contract block instead of the full host wake pack (see src/role-orient.ts).
        // The child id is available synchronously after startContinuable; the same
        // code path serves BOTH `subagent` and the `subagent_fork` provider (they
        // differ only by inheritsParentContext/mount), so the role plumbing covers
        // both variants automatically.
        rememberRole(child.childId as string, args.role)
        return {
          kind: 'continuable',
          subagentId: child.childId as string
        }
      }
    }))
  }
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === config.provider && disposeTool === void 0) mount(provider)
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== config.provider || disposeTool === void 0) return
    disposeTool()
    disposeTool = void 0
  })
  const present = ctx.subagents.getProvider(config.provider)
  if (present !== void 0) mount(present)
  else ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${toolName}" tool will register when it appears`)
  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: SUBAGENT_SECTION_ORDER,
    text: (context: AssembleContext) => disposeTool === void 0 || ctx.tools.get(toolName, context.scope) === void 0 ? '' : `Use ${toolName} ALWAYS in the background — it has no blocking mode. Start independent delegations together in one assistant message and continue useful work while they run. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message; continue dependent work only when that notice arrives. Use send_message to give a child follow-up work. Never wait inline for a subagent; never busy-poll.`
  })
}
