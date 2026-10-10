import type { Requester } from '../domain/types';
import type { ShippingAddress } from '../reap/types';

/**
 * Integration contract for the purchasing agent.
 *
 * SpendGuard does not ship an agent: plug yours in by implementing `Agent` and passing it to
 * `buildApp({ agent })` (an instance, or a factory that receives the PurchaseService).
 * Use `AgentToolbox` / `TOOL_DEFINITIONS` from ./tools to give your model policy-safe tools:
 * the requester and department always come from the session, and every purchase goes through
 * PurchaseService.propose(), which applies company policy before any Reap payment link exists.
 */

/** 'none' = no agent connected; 'external' (or any other label) = an agent plugged in by the team. */
export type AgentMode = 'none' | 'external' | (string & {});

export interface AgentInput {
  message: string;
  /** Who the agent acts for. Comes from the session, never from the model. */
  requester: Requester;
  departmentId: string;
  /** Opaque conversation state returned by a previous chat() call; the client just sends it back. */
  history?: unknown[];
  shippingAddress?: ShippingAddress;
}

export interface AgentResult {
  reply: string;
  /** Purchase requests created or inspected during this turn (the API returns them expanded). */
  requestIds: string[];
  /** Opaque conversation state to send back on the next turn. */
  history: unknown[];
  mode: AgentMode;
}

export interface Agent {
  /** Reported by GET /api/health as agentMode. */
  readonly mode: AgentMode;
  chat(input: AgentInput): Promise<AgentResult>;
}
