import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PolicyProvider } from '../src/domain/policy';
import { PurchaseService } from '../src/services/purchase-service';
import { Mutex } from '../src/util/mutex';
import { JsonStore } from '../src/store/store';
import { makeCtx, pay, proposal, testPolicyInput } from './helpers';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'spendguard-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('JsonStore', () => {
  it('returns copies, so callers cannot mutate stored state', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng' }));
    const copy = ctx.store.get(req.id)!;
    copy.status = 'COMPLETED';
    ctx.store.list()[0]!.status = 'COMPLETED';
    expect(ctx.store.get(req.id)!.status).toBe('AWAITING_PAYMENT');
  });

  it('persists requests and audit to disk and reloads them', async () => {
    const file = join(tmp(), 'nested', 'store.json');
    const ctx = makeCtx();
    // Re-wire with a file-backed store sharing the same mock and clock.
    const store = new JsonStore(file);
    const service = new PurchaseService({
      store,
      reap: ctx.mock,
      policy: ctx.policy,
      publicBaseUrl: 'http://localhost:3000',
      defaultShipping: { firstName: 'a', lastName: 'b', phone: '+1', addressLine1: 'x', city: 'y', country: 'US' },
      now: ctx.clock.now,
    });
    const req = await service.propose(proposal({ productId: 'p_switches', departmentId: 'eng' }));
    await pay({ ...ctx, service, store }, req);

    const reloaded = new JsonStore(file);
    expect(reloaded.get(req.id)?.status).toBe('COMPLETED');
    expect(reloaded.listAudit(req.id).map((e) => e.type)).toEqual(store.listAudit(req.id).map((e) => e.type));
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('moves a corrupt file aside and starts empty', () => {
    const dir = tmp();
    const file = join(dir, 'store.json');
    writeFileSync(file, '{ not json');
    const store = new JsonStore(file);
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith('store.json.corrupt-'))).toBe(true);
  });

  it('filters by status and department', async () => {
    const ctx = makeCtx();
    await ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng' }));
    await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng' }));
    await ctx.service.propose(proposal({ productId: 'p_planter', departmentId: 'ops' }));
    expect(ctx.service.list({ departmentId: 'eng' })).toHaveLength(2);
    expect(ctx.service.list({ status: ['PENDING_APPROVAL', 'DENIED'] }).map((r) => r.status).sort()).toEqual(['DENIED', 'PENDING_APPROVAL']);
  });
});

describe('PolicyProvider', () => {
  it('validates, bumps the version and persists on replace; logs POLICY_UPDATED', () => {
    const file = join(tmp(), 'policy.json');
    const ctx = makeCtx();
    const provider = new PolicyProvider(file, ctx.policy.get());
    const next = provider.replace({ ...testPolicyInput, version: 99 });
    expect(next.version).toBe(2);
    expect(new PolicyProvider(file).get().version).toBe(2);
    expect(() => provider.replace({ ...testPolicyInput, baseCurrency: 'DOLLARS' })).toThrow();
    expect(provider.get().version).toBe(2);

    ctx.service.updatePolicy(testPolicyInput, 'admin@acme.test');
    expect(ctx.service.audit().at(-1)).toMatchObject({ type: 'POLICY_UPDATED', actor: 'admin@acme.test', requestId: null, data: { fromVersion: 1, toVersion: 2 } });
  });
});

describe('Mutex', () => {
  it('runs critical sections one at a time and survives a failing one', async () => {
    const m = new Mutex();
    const order: string[] = [];
    const slow = (name: string, ms: number) =>
      m.run(async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${name}:end`);
        return name;
      });
    const failing = m.run(async () => {
      throw new Error('boom');
    });
    const results = await Promise.allSettled([slow('a', 10), failing, slow('b', 1)]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
