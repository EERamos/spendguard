import { describe, expect, it } from 'vitest';
import { LiveReapClient } from '../src/reap/client';
import { ReapApiError } from '../src/reap/errors';
import type { CheckoutRequest, QuoteRequest } from '../src/reap/types';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const r = replies.shift();
    if (!r) throw new Error('fakeFetch: no more replies');
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  }) as typeof fetch;
  return { impl, calls };
}

function makeClient(replies: Reply[], maxRetries = 3) {
  const f = fakeFetch(replies);
  const sleeps: number[] = [];
  const client = new LiveReapClient({
    baseUrl: 'https://api.reap.test/',
    apiKey: 'sk_test_123',
    version: '2025-02-14',
    fetchImpl: f.impl,
    maxRetries,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { client, calls: f.calls, sleeps };
}

const QUOTE_REQ: QuoteRequest = { email: 'a@acme.test', items: [{ variantId: 'v1', quantity: 1 }] };
const QUOTE = {
  id: 'quo_1',
  shippingOptions: [],
  amountBreakdown: { itemsSubtotal: { amount: 1, currency: 'USD' }, discounts: [], additionalCharges: [], finalAmount: { amount: 1, currency: 'USD' } },
  expiresAt: '2026-10-09T12:10:00.000Z',
};
const CHECKOUT_REQ: CheckoutRequest = {
  quoteId: 'quo_1',
  owner: { type: 'CLIENT_REFERENCE', reference: 'u1' },
  presentation: { type: 'REDIRECT', returnUrl: 'http://localhost:3000/return/req_1' },
};
const SERVER_ERROR = { status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } };

describe('LiveReapClient', () => {
  it('sends auth, version and idempotency headers to the right URL', async () => {
    const { client, calls } = makeClient([{ status: 200, body: QUOTE }]);
    const q = await client.createQuote(QUOTE_REQ, 'quote:req_1:1');
    expect(q).toEqual(QUOTE);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://api.reap.test/agentic/quotes',
      method: 'POST',
      body: QUOTE_REQ,
      headers: {
        Authorization: 'Bearer sk_test_123',
        'Reap-Version': '2025-02-14',
        'Idempotency-Key': 'quote:req_1:1',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
  });

  it('omits Idempotency-Key and Content-Type on plain reads, and encodes ids', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { id: 'chk/1', status: 'PROCESSING' } }]);
    await client.getCheckout('chk/1');
    expect(calls[0]!.url).toBe('https://api.reap.test/agentic/checkouts/chk%2F1');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['Idempotency-Key']).toBeUndefined();
    expect(calls[0]!.headers['Content-Type']).toBeUndefined();
    expect(calls[0]!.headers.Authorization).toBe('Bearer sk_test_123');
  });

  it('retries 429 honouring Retry-After, keeping the same idempotency key', async () => {
    const { client, calls, sleeps } = makeClient([
      { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'slow down' } }, headers: { 'Retry-After': '2' } },
      { status: 200, body: { id: 'chk_1', status: 'REQUIRES_ACTION' } },
    ]);
    const c = await client.createCheckout(CHECKOUT_REQ, 'checkout:req_1:quo_1');
    expect(c.id).toBe('chk_1');
    expect(sleeps).toEqual([2000]);
    expect(calls.map((c) => c.headers['Idempotency-Key'])).toEqual(['checkout:req_1:quo_1', 'checkout:req_1:quo_1']);
  });

  it('falls back to exponential backoff without a usable Retry-After', async () => {
    const { client, sleeps } = makeClient([{ status: 429 }, { status: 429, headers: { 'Retry-After': 'soon' } }, { status: 200, body: QUOTE }]);
    await client.getQuote('quo_1');
    expect(sleeps).toEqual([500, 1000]);
  });

  it('gives up after maxRetries and surfaces the last error', async () => {
    const { client, calls } = makeClient(
      [
        { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'slow down' } } },
        { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'slow down' } } },
        { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'still slow' } } },
      ],
      2,
    );
    await expect(client.getQuote('quo_1')).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED', message: 'RATE_LIMITED: still slow' });
    expect(calls).toHaveLength(3);
  });

  it('retries quote creation on 5xx with a derived idempotency key', async () => {
    const { client, calls } = makeClient([SERVER_ERROR, SERVER_ERROR, { status: 200, body: QUOTE }]);
    await client.createQuote(QUOTE_REQ, 'quote:req_1:1');
    expect(calls.map((c) => c.headers['Idempotency-Key'])).toEqual(['quote:req_1:1', 'quote:req_1:1:r1', 'quote:req_1:1:r2']);
    expect(calls.every((c) => JSON.stringify(c.body) === JSON.stringify(QUOTE_REQ))).toBe(true);
  });

  it('never retries checkout creation on 5xx', async () => {
    const { client, calls, sleeps } = makeClient([SERVER_ERROR, { status: 200, body: { id: 'chk_dup' } }]);
    const err = await client.createCheckout(CHECKOUT_REQ, 'checkout:req_1:quo_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReapApiError);
    expect(err).toMatchObject({ status: 500, code: 'INTERNAL' });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('retries reads on 5xx with the same request', async () => {
    const { client, calls } = makeClient([{ status: 503 }, { status: 200, body: { id: 'chk_1', status: 'COMPLETED' } }]);
    const c = await client.getCheckout('chk_1');
    expect(c.status).toBe('COMPLETED');
    expect(calls).toHaveLength(2);
  });

  it('retries network errors with the same key, then reports NETWORK_ERROR', async () => {
    const ok = makeClient([new TypeError('fetch failed'), { status: 200, body: { id: 'chk_1' } }]);
    await ok.client.createCheckout(CHECKOUT_REQ, 'k1');
    expect(ok.calls.map((c) => c.headers['Idempotency-Key'])).toEqual(['k1', 'k1']);

    const bad = makeClient([new TypeError('fetch failed'), new TypeError('fetch failed')], 1);
    await expect(bad.client.getQuote('quo_1')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR', message: 'NETWORK_ERROR: fetch failed' });
  });

  it('maps Reap error bodies to ReapApiError and does not retry 4xx', async () => {
    const detail = { field: 'items' };
    const { client, calls } = makeClient([{ status: 400, body: { error: { code: 'AGENTIC_REQUEST_REJECTED', message: 'items is required', detail } } }]);
    const err = await client.createQuote(QUOTE_REQ, 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReapApiError);
    expect(err).toMatchObject({ status: 400, code: 'AGENTIC_REQUEST_REJECTED', message: 'AGENTIC_REQUEST_REJECTED: items is required', detail });
    expect(calls).toHaveLength(1);
  });

  it('maps bodies without an error envelope to HTTP_<status>', async () => {
    const { client } = makeClient([{ status: 404 }]);
    await expect(client.getQuote('nope')).rejects.toMatchObject({ status: 404, code: 'HTTP_404' });
    expect(ReapApiError.fromResponse(502, 'garbage')).toMatchObject({ status: 502, code: 'HTTP_502' });
  });

  it('wraps non-JSON error bodies', async () => {
    const client = new LiveReapClient({
      baseUrl: 'https://api.reap.test',
      apiKey: 'k',
      version: 'v',
      fetchImpl: (async () => new Response('<html>Bad gateway</html>', { status: 403 })) as typeof fetch,
      sleep: async () => {},
    });
    await expect(client.getQuote('q')).rejects.toMatchObject({ status: 403, code: 'NON_JSON_RESPONSE' });
  });
});
