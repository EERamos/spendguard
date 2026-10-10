import { describe, expect, it } from 'vitest';
import { PolicyProvider } from '../src/domain/policy';
import { ReapApiError } from '../src/reap/errors';
import { MockReapClient } from '../src/reap/mock';
import type { ReapClient } from '../src/reap/types';
import { PurchaseService } from '../src/services/purchase-service';
import { JsonStore } from '../src/store/store';
import { CTO, US_ADDRESS, expectedTotal, makeClock, proposal, testPolicy } from './helpers';

type Method = 'createQuote' | 'createCheckout' | 'getCheckout';

/** Wraps the mock so the next N calls of a method fail with the given error; records idempotency keys. */
function faultyCtx() {
  const clock = makeClock();
  const mock = new MockReapClient({ now: clock.now });
  const faults: Partial<Record<Method, ReapApiError[]>> = {};
  const keys: Record<string, string[]> = { createQuote: [], createCheckout: [] };
  const reap: ReapClient = new Proxy(mock, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== 'function') return orig;
      return async (...args: unknown[]) => {
        if (prop === 'createQuote' || prop === 'createCheckout') keys[prop]!.push(args[1] as string);
        const queue = faults[prop as Method];
        if (queue && queue.length > 0) throw queue.shift();
        return (orig as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const store = new JsonStore(null);
  const service = new PurchaseService({
    store,
    reap,
    policy: new PolicyProvider(null, testPolicy()),
    publicBaseUrl: 'http://localhost:3000/',
    defaultShipping: US_ADDRESS,
    now: clock.now,
  });
  const fail = (m: Method, ...errs: ReapApiError[]) => void (faults[m] = [...(faults[m] ?? []), ...errs]);
  const reserved = (dept = 'eng') => service.budgets().find((b) => b.departmentId === dept)!.reserved;
  return { service, mock, clock, fail, keys, reserved };
}

const rateLimited = () => new ReapApiError(429, 'RATE_LIMITED', 'slow down');
const serverError = () => new ReapApiError(500, 'INTERNAL', 'boom');

describe('Reap failures', () => {
  it('an auto-approved purchase whose checkout cannot be opened is FAILED and releases the budget', async () => {
    const ctx = faultyCtx();
    ctx.fail('createCheckout', serverError());
    const req = await ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng' }));
    expect(req).toMatchObject({ status: 'FAILED', failure: { code: 'REAP_INTERNAL' } });
    expect(ctx.service.audit(req.id).map((e) => e.type)).toContain('CHECKOUT_FAILED');
    expect(ctx.reserved()).toBe(0);
  });

  it('uses the configured public URL (trailing slash trimmed) for the return URL', async () => {
    const ctx = faultyCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng' }));
    expect(ctx.mock.describeCheckout(req.checkout!.id).returnUrl).toBe(`http://localhost:3000/return/${req.id}`);
  });

  it('a transient checkout failure during approval keeps the request pending; retrying reuses the same key', async () => {
    const ctx = faultyCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng' }));
    ctx.fail('createCheckout', rateLimited());

    await expect(ctx.service.approve(req.id, CTO)).rejects.toMatchObject({ status: 429 });
    expect(ctx.service.get(req.id).status).toBe('PENDING_APPROVAL');
    expect(ctx.reserved()).toBe(expectedTotal('p_monitor', 1));

    const ok = await ctx.service.approve(req.id, CTO);
    expect(ok.status).toBe('AWAITING_PAYMENT');
    expect(ctx.keys.createCheckout).toEqual([`checkout:${req.id}:${req.quote.id}`, `checkout:${req.id}:${req.quote.id}`]);
    expect(ctx.mock.checkoutCount).toBe(1);
  });

  it('a permanent checkout failure during approval closes the request', async () => {
    const ctx = faultyCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng' }));
    ctx.fail('createCheckout', serverError());
    const res = await ctx.service.approve(req.id, CTO);
    expect(res).toMatchObject({ status: 'FAILED', failure: { code: 'REAP_INTERNAL' } });
    expect(ctx.reserved()).toBe(0);
  });

  it('a transient re-quote failure leaves the request pending and the retry uses a fresh quote key', async () => {
    const ctx = faultyCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng' }));
    ctx.clock.advance(11 * 60_000);
    ctx.fail('createQuote', rateLimited());

    await expect(ctx.service.approve(req.id, CTO)).rejects.toMatchObject({ status: 429 });
    expect(ctx.service.get(req.id)).toMatchObject({ status: 'PENDING_APPROVAL', quote: { attempt: 1 } });

    const ok = await ctx.service.approve(req.id, CTO);
    expect(ok.status).toBe('AWAITING_PAYMENT');
    expect(ok.quote.attempt).toBe(2);
    expect(ctx.keys.createQuote).toEqual([`quote:${req.id}:1`, `quote:${req.id}:2`, `quote:${req.id}:2:f1`]);
  });

  it('a permanent re-quote failure closes the request', async () => {
    const ctx = faultyCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng' }));
    ctx.clock.advance(11 * 60_000);
    ctx.fail('createQuote', new ReapApiError(409, 'VARIANT_UNAVAILABLE', 'sold out'));
    const res = await ctx.service.approve(req.id, CTO);
    expect(res).toMatchObject({ status: 'FAILED', failure: { code: 'REAP_VARIANT_UNAVAILABLE' } });
  });

  it('reconcileOpen keeps going when one poll fails', async () => {
    const ctx = faultyCtx();
    const a = await ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng' }));
    const b = await ctx.service.propose(proposal({ productId: 'p_towels', departmentId: 'eng' }));
    ctx.mock.approveCheckout(a.checkout!.id);
    ctx.mock.approveCheckout(b.checkout!.id);
    ctx.fail('getCheckout', rateLimited());
    const summary = await ctx.service.reconcileOpen();
    expect(summary.checked).toBe(2);
    expect(summary.changed).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.message).toContain('RATE_LIMITED');
  });
});
