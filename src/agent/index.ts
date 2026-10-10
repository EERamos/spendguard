import type { AppConfig } from '../config';
import type { PurchaseService } from '../services/purchase-service';
import { ClaudeAgent } from './claude-agent';
import { RuleBasedAgent } from './rule-agent';
import type { Agent } from './types';

/** Claude when an Anthropic key is configured (falling back to rules if the API is unreachable), rules otherwise. */
export function createAgent(config: AppConfig, service: PurchaseService): Agent {
  const rules = new RuleBasedAgent(service);
  if (!config.anthropicApiKey) return rules;
  return new ClaudeAgent({ service, model: config.agentModel, apiKey: config.anthropicApiKey, fallback: rules });
}

export { ClaudeAgent, RuleBasedAgent };
export type { Agent };
export type { AgentInput, AgentResult } from './types';
export { AgentToolbox, TOOL_DEFINITIONS, describeRequest } from './tools';
