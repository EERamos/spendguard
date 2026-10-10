import type { Requester } from '../domain/types';
import type { ShippingAddress } from '../reap/types';

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
  /** Purchase requests created or inspected during this turn. */
  requestIds: string[];
  /** Opaque conversation state to send back on the next turn. */
  history: unknown[];
  mode: 'claude' | 'rules';
}

export interface Agent {
  readonly mode: 'claude' | 'rules';
  chat(input: AgentInput): Promise<AgentResult>;
}

/** Plain text conversation turn, the history format shared by both agents. */
export interface TextTurn {
  role: 'user' | 'assistant';
  content: string;
}
