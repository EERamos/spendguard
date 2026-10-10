/**
 * SpendGuard MCP server (stdio). Lets any MCP client (Claude Code, Claude Desktop, Cursor) buy under company policy.
 *
 * It is a thin proxy: every tool call goes to the running SpendGuard API (POST /api/agent/tool), so the policy
 * engine, the budget mutex and the dashboard stay in one process.
 *
 * Who the agent acts for comes from this process's environment, set by whoever configures the MCP client,
 * never from the model: SPENDGUARD_USER_EMAIL, SPENDGUARD_DEPARTMENT and (optional) SPENDGUARD_URL.
 *
 * stdout carries the MCP protocol: log to stderr only.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS } from '../agent/tools';
import type { ToolOutcome } from '../agent/tools';

const baseUrl = (process.env.SPENDGUARD_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const requesterEmail = process.env.SPENDGUARD_USER_EMAIL;
const departmentId = process.env.SPENDGUARD_DEPARTMENT;

if (!requesterEmail || !departmentId) {
  console.error('SpendGuard MCP: faltan SPENDGUARD_USER_EMAIL y SPENDGUARD_DEPARTMENT en el entorno del servidor MCP.');
  process.exit(1);
}

const INSTRUCTIONS = `SpendGuard puts company spend policy in front of Reap agentic payments.
You act for ${requesterEmail} in department "${departmentId}". That identity is fixed by the administrator; you cannot change it.
- propose_purchase is the ONLY way to buy. SpendGuard quotes the real total with Reap (item, shipping, tax) and applies the policy.
- AUTO_APPROVE returns a Reap payment link: give it to the user. The card holder authorizes the charge on Reap's hosted page.
- REQUIRE_APPROVAL: tell the user who must approve in the SpendGuard dashboard. You cannot approve.
- DENY: explain the reasons and offer an allowed alternative. Do not try to get around the policy (for example by splitting an order).
- You never pay and never see or ask for card data.`;

const server = new Server({ name: 'spendguard', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
}));

const text = (value: string, isError: boolean) => ({ content: [{ type: 'text' as const, text: value }], isError });

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/agent/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: req.params.name, input: req.params.arguments ?? {}, requesterEmail, departmentId }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    return text(`SpendGuard no responde en ${baseUrl} (${e instanceof Error ? e.message : String(e)}). Arranca el servidor con "npm run dev".`, true);
  }
  const raw = await res.text();
  if (!res.ok) return text(raw || `SpendGuard respondio HTTP ${res.status}`, true);
  const outcome = JSON.parse(raw) as ToolOutcome;
  return text(outcome.content, outcome.isError);
});

await server.connect(new StdioServerTransport());
console.error(`SpendGuard MCP listo: ${requesterEmail} / ${departmentId} -> ${baseUrl}`);
