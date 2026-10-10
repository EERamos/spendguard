import Anthropic from '@anthropic-ai/sdk';
import type { PurchaseService } from '../services/purchase-service';
import { AgentToolbox, TOOL_DEFINITIONS } from './tools';
import type { Agent, AgentInput, AgentResult } from './types';

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

/** The slice of the SDK the agent uses; injectable so tests can script the model. */
export interface MessagesApi {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export interface ClaudeAgentOptions {
  service: PurchaseService;
  model: string;
  apiKey?: string;
  /** Overrides the real SDK (tests). */
  messages?: MessagesApi;
  maxSteps?: number;
  maxTokens?: number;
  /** Max history messages kept between turns. */
  maxHistory?: number;
  /** Used when the Claude API cannot be reached before any tool ran (e.g. bad key, no network). */
  fallback?: Agent;
}

const SYSTEM_PROMPT = `You are SpendGuard's purchasing agent for the company. You help employees buy things from online merchants supported by Reap Agentic Payments.

Hard rules:
- You never pay and you never see, ask for or handle card data. Payment happens only on Reap's hosted page, where the card holder reviews and authorizes the charge.
- Every purchase MUST go through the propose_purchase tool. It gets a real quote from Reap and applies company policy (budgets, blocked merchants and categories, per-purchase caps, approvals). You cannot bypass, negotiate or second-guess the policy, and you must not split one purchase into several smaller ones to slip under a limit.
- The requester and department are fixed by the session; do not ask for them.

How to work:
1. Use search_products to find candidates (it already hides products policy would block and tells you why in filteredOut). Prefer the cheapest available product that fits the request unless the user asked for something specific. If a product has options, call get_product_options and pick the optionIds that match what the user asked for.
2. Call propose_purchase once per item with the quantity and a short business justification in the user's own words. Set declaredMaxTotal only if the user stated a total budget for the purchase.
3. Explain the decision clearly and briefly:
   - AUTO_APPROVE / AWAITING_PAYMENT: say it was approved by policy and share the Reap payment link (paymentUrl) so the card holder can authorize the charge.
   - REQUIRE_APPROVAL / PENDING_APPROVAL: say who must approve (approvers) and why it needs approval (reasons). No payment link exists until they approve.
   - DENY / DENIED: say why (reasons) and suggest concrete allowed alternatives (another merchant, a cheaper model, a smaller quantity, or asking an approver to change the policy).
   Always mention the quoted total (it includes shipping and tax).
4. If something is ambiguous (e.g. which product or how many), ask one short question instead of guessing.

Reply in the user's language (default: Mexican Spanish). Be concise; no markdown tables.`;

function sessionContext(service: PurchaseService, input: AgentInput): string {
  const policy = service.getPolicy();
  const dept = policy.departments[input.departmentId];
  const budget = service.budgets().find((b) => b.departmentId === input.departmentId);
  const lines = [
    `Session: requester ${input.requester.email}, department "${input.departmentId}"${dept ? ` (${dept.name})` : ' (unknown department)'}.`,
    `Today: ${new Date().toISOString().slice(0, 10)}. Policy version ${policy.version}, base currency ${policy.baseCurrency}.`,
  ];
  if (dept && budget) {
    lines.push(
      `Department rules: auto-approve up to ${dept.autoApproveUnder} ${policy.baseCurrency}, hard cap ${dept.hardCapPerPurchase} per purchase, ` +
        `monthly budget ${dept.monthlyBudget} (remaining ${budget.remaining}), approvers: ${dept.approvers.join(', ') || 'anyone'}.`,
    );
  }
  return lines.join('\n');
}

/** Keeps only well-formed messages, and starts history on a plain user turn so no tool_result is orphaned. */
export function sanitizeHistory(raw: unknown[] | undefined, max: number): MessageParam[] {
  if (!Array.isArray(raw)) return [];
  const ok = raw.filter((m): m is MessageParam => {
    if (!m || typeof m !== 'object') return false;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant') return false;
    if (typeof content === 'string') return true;
    return (
      Array.isArray(content) &&
      content.every((b) => b && typeof b === 'object' && ['text', 'tool_use', 'tool_result'].includes((b as { type?: string }).type ?? ''))
    );
  });
  let out = ok.slice(-max);
  const firstPlainUser = out.findIndex((m) => m.role === 'user' && typeof m.content === 'string');
  out = firstPlainUser === -1 ? [] : out.slice(firstPlainUser);
  return out;
}

/** Converts response blocks to request params, keeping only what we replay (text and tool calls). */
function toParams(content: Anthropic.ContentBlock[]): ContentBlockParam[] {
  const out: ContentBlockParam[] = [];
  for (const b of content) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
  }
  return out;
}

const textOf = (content: Anthropic.ContentBlock[]): string =>
  content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

/** Claude with a manual tool-use loop over the SpendGuard tools. */
export class ClaudeAgent implements Agent {
  readonly mode = 'claude' as const;
  private readonly api: MessagesApi;
  private readonly maxSteps: number;
  private readonly maxTokens: number;
  private readonly maxHistory: number;

  constructor(private readonly opts: ClaudeAgentOptions) {
    if (opts.messages) {
      this.api = opts.messages;
    } else {
      const sdk = new Anthropic({ apiKey: opts.apiKey });
      this.api = { create: (params) => sdk.messages.create(params) };
    }
    this.maxSteps = opts.maxSteps ?? 8;
    this.maxTokens = opts.maxTokens ?? 1500;
    this.maxHistory = opts.maxHistory ?? 40;
  }

  async chat(input: AgentInput): Promise<AgentResult> {
    const toolbox = new AgentToolbox(this.opts.service, {
      requester: input.requester,
      departmentId: input.departmentId,
      ...(input.shippingAddress ? { shippingAddress: input.shippingAddress } : {}),
    });
    const messages: MessageParam[] = [...sanitizeHistory(input.history, this.maxHistory), { role: 'user', content: input.message }];
    const system = `${SYSTEM_PROMPT}\n\n${sessionContext(this.opts.service, input)}`;
    const requestIds = new Set<string>();
    let toolsRan = false;
    let reply = '';

    for (let step = 0; step < this.maxSteps; step++) {
      const last = step === this.maxSteps - 1;
      let res: Anthropic.Message;
      try {
        res = await this.api.create({
          model: this.opts.model,
          max_tokens: this.maxTokens,
          system,
          tools: TOOL_DEFINITIONS,
          // On the last step force a plain answer so the turn always ends with text.
          ...(last ? { tool_choice: { type: 'none' as const } } : {}),
          messages,
        });
      } catch (e) {
        if (!toolsRan && this.opts.fallback) {
          const fb = await this.opts.fallback.chat(input);
          const why = e instanceof Error ? e.message : String(e);
          return { ...fb, reply: `(Claude no está disponible: ${why.slice(0, 160)}. Respondí con el agente de reglas.)\n\n${fb.reply}` };
        }
        if (!toolsRan) throw e;
        reply = 'Tuve un problema al hablar con el modelo, pero las acciones anteriores sí se registraron. Revisa el estado en el dashboard.';
        break;
      }

      const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || calls.length === 0) {
        // Never keep a tool_use without its tool_result (e.g. cut off by max_tokens): the next turn would be rejected.
        reply = textOf(res.content);
        if (reply) messages.push({ role: 'assistant', content: reply });
        break;
      }
      messages.push({ role: 'assistant', content: toParams(res.content) });

      const results: ToolResultBlockParam[] = [];
      for (const call of calls) {
        toolsRan = true;
        const out = await toolbox.execute(call.name, call.input);
        out.requestIds.forEach((id) => requestIds.add(id));
        results.push({ type: 'tool_result', tool_use_id: call.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }

    if (!reply) reply = 'Listo. Revisa el detalle de la solicitud en el dashboard.';
    // Keep the turn's final text as an assistant message so the history always alternates cleanly.
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role !== 'assistant') messages.push({ role: 'assistant', content: reply });

    return { reply, requestIds: [...requestIds], history: messages.slice(-this.maxHistory), mode: 'claude' };
  }
}
