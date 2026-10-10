import { describe, expect, it } from 'vitest';
import { ReapApiError } from '../src/reap/errors';
import { HybridReapClient } from '../src/reap/hybrid';
import type { Quote, ReapClient } from '../src/reap/types';

const usd = (amount: number) => ({ amount, currency: 'USD' });

function setup(expiresInMs = 60_000) {
  let nowMs = Date.parse('2026-10-09T12:00:00Z');
  const quote: Quote = {
    id: 'q_live_1',
    shippingOptions: [],
    amountBreakdown: {
      itemsSubtotal: usd(7.99),
      shipping: usd(6.9),
      tax: { amount: usd(0.69) },
      discounts: [],
      additionalCharges: [],
      finalAmount: usd(15.58),
    },
    expiresAt: new Date(nowMs + expiresInMs).toISOString(),
  };
  const calls: string[] = [];
  const live = {
    getQuote: async (id: string) => {
      calls.push(`getQuote:${id}`);
      return quote;
    },
    createCheckout: async () => {
      throw new Error('the live checkout must never be called');
    },
  } as unknown as ReapClient;
  const client = new HybridReapClient(live, { publicBaseUrl: 'http://localhost:3000/', now: () => nowMs });
  const request = { quoteId: quote.id, presentation: { type: 'REDIRECT' as const, returnUrl: 'http://localhost:3000/return/req_1' } };
  return { client, calls, request, advance: (ms: number) => (nowMs += ms) };
}

describe('HybridReapClient', () => {
  it('charges the amount Reap quoted and points at the simulated approval page', async () => {
    const { client, calls, request } = setup();
    const c = await client.createCheckout(request, 'checkout:req_1:q_live_1');
    expect(calls).toEqual(['getQuote:q_live_1']);
    expect(c.status).toBe('REQUIRES_ACTION');
    expect(c.amount).toEqual(usd(15.58));
    expect(c.nextAction?.url).toBe(`http://localhost:3000/mock/reap/approve/${c.id}`);
  });

  it('replays the same checkout for the same idempotency key', async () => {
    const { client, request } = setup();
    const a = await client.createCheckout(request, 'k1');
    const b = await client.createCheckout(request, 'k1');
    expect(b.id).toBe(a.id);
  });

  it('refuses an expired Reap quote', async () => {
    const { client, request, advance } = setup(1_000);
    advance(2_000);
    await expect(client.createCheckout(request, 'k1')).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
  });

  it('completes with a SIM order id after approval, at the final amount', async () => {
    const { client, request } = setup();
    const c = await client.createCheckout(request, 'k1');
    expect(client.approveCheckout(c.id, { finalAmount: 16 })).toEqual({ returnUrl: request.presentation.returnUrl });
    const done = await client.getCheckout(c.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.orderId).toMatch(/^SIM-/);
    expect(done.finalAmount).toEqual(usd(16));
    expect(done.nextAction).toBeNull();
    expect(() => client.approveCheckout(c.id)).toThrow(ReapApiError);
  });

  it('describes the checkout from the real quote breakdown', async () => {
    const { client, request } = setup();
    const c = await client.createCheckout(request, 'k1');
    const d = client.describeCheckout(c.id);
    expect(d.lines.map((l) => [l.name, l.unit])).toEqual([
      ['Productos', 7.99],
      ['Envío', 6.9],
      ['Impuestos', 0.69],
    ]);
  });
});
