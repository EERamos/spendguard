import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

/** POST /api/agent/tool is what the MCP server proxies to: one policy-safe tool call per request. */
async function setup() {
  const { app, service } = await buildApp({ config: { dataFile: null, logger: false, reapMode: 'mock' } });
  const call = async (name: string, input: unknown, session: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/tool',
      payload: { name, input, requesterEmail: 'ana@acme.test', departmentId: 'eng', ...session },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, any> };
  };
  return { call, service };
}

describe('POST /api/agent/tool', () => {
  it('runs a read tool and returns the toolbox outcome', async () => {
    const { call } = await setup();
    const res = await call('search_products', { query: 'switches' });
    expect(res.status).toBe(200);
    expect(res.body.isError).toBe(false);
    expect(JSON.parse(res.body.content).products.length).toBeGreaterThan(0);
  });

  it('auto-approves a cheap purchase and returns the Reap payment link', async () => {
    const { call } = await setup();
    const res = await call('propose_purchase', { productId: 'p_switches', quantity: 1, justification: 'Repuestos para el laboratorio' });
    const view = JSON.parse(res.body.content);
    expect(view.outcome).toBe('AUTO_APPROVE');
    expect(view.paymentUrl).toBeTruthy();
    expect(res.body.requestIds).toEqual([view.requestId]);
  });

  it('denies a blocked merchant without creating a payment link', async () => {
    const { call } = await setup();
    const res = await call('propose_purchase', { productId: 'p_planter', quantity: 1, justification: 'Decoracion para la oficina' });
    const view = JSON.parse(res.body.content);
    expect(view.outcome).toBe('DENY');
    expect(view.paymentUrl).toBeUndefined();
  });

  it('takes requester and department from the session, never from the tool input', async () => {
    const { call, service } = await setup();
    const res = await call('propose_purchase', {
      productId: 'p_switches',
      quantity: 1,
      justification: 'Repuestos para el laboratorio',
      departmentId: 'marketing',
      requesterEmail: 'cto@acme.test',
      requester: { id: 'cto', email: 'cto@acme.test' },
    });
    const request = service.get(res.body.requestIds[0]);
    expect(request.departmentId).toBe('eng');
    expect(request.requester.email).toBe('ana@acme.test');
  });

  it('reports an unknown tool as a tool error, not an HTTP failure', async () => {
    const { call } = await setup();
    const res = await call('approve_request', { requestId: 'req_1' });
    expect(res.status).toBe(200);
    expect(res.body.isError).toBe(true);
    expect(res.body.content).toContain('UNKNOWN_TOOL');
  });

  it('rejects a call without a session identity', async () => {
    const { call } = await setup();
    const res = await call('get_budget', {}, { requesterEmail: undefined });
    expect(res.status).toBe(400);
  });
});
