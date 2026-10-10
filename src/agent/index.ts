import type { AppConfig } from '../config';
import type { PurchaseService } from '../services/purchase-service';
import { NotConfiguredAgent } from './not-configured';
import type { Agent } from './types';

/**
 * Default agent when none is injected via buildApp({ agent }).
 * The purchasing agent is built separately; plug it in by implementing `Agent` (./types).
 */
export function createAgent(_config: AppConfig, _service: PurchaseService): Agent {
  return new NotConfiguredAgent();
}

export { NotConfiguredAgent, NOT_CONFIGURED_REPLY } from './not-configured';
export type { Agent, AgentInput, AgentMode, AgentResult } from './types';
export { AgentToolbox, TOOL_DEFINITIONS, describeRequest } from './tools';
export type { RequestView, ToolDefinition, ToolOutcome, ToolSession } from './tools';
