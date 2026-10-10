import type { Agent, AgentInput, AgentResult } from './types';

export const NOT_CONFIGURED_REPLY =
  'El agente todavía no está conectado. Usa la API /api/requests o conecta tu agente implementando la interfaz Agent (src/agent/types.ts).';

/** Placeholder used until a real agent is injected with buildApp({ agent }). */
export class NotConfiguredAgent implements Agent {
  readonly mode = 'none' as const;

  async chat(input: AgentInput): Promise<AgentResult> {
    return {
      reply: NOT_CONFIGURED_REPLY,
      requestIds: [],
      history: Array.isArray(input.history) ? input.history : [],
      mode: 'none',
    };
  }
}
