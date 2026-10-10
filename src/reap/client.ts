import { ReapApiError } from './errors';
import type {
  Checkout,
  CheckoutRequest,
  ProductDetailsResponse,
  Quote,
  QuoteRequest,
  ReapClient,
  SearchProductsRequest,
  SearchProductsResponse,
  Variant,
} from './types';

export interface LiveClientOptions {
  baseUrl: string;
  apiKey: string;
  version: string;
  fetchImpl?: typeof fetch;
  /** Retries for 429/503/network errors. Default 3. */
  maxRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  /**
   * What to do on a 5xx. Reap caches 5xx responses per Idempotency-Key, so replaying the same key just replays the error.
   *  - 'retry'         reads and idempotent-by-nature calls: retry as is (default)
   *  - 'retry-new-key' side-effect-light creates (quotes): retry with a derived Idempotency-Key
   *  - 'fail'          never retry (checkout creation: a duplicate charge is worse than an error)
   */
  onServerError?: 'retry' | 'retry-new-key' | 'fail';
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Thin HTTP client over the Reap Agentic Payments API. Authentication, versioning and retries live here only. */
export class LiveReapClient implements ReapClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: LiveClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, o: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let key = o.idempotencyKey;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Reap-Version': this.opts.version,
        Accept: 'application/json',
      };
      if (o.body !== undefined) headers['Content-Type'] = 'application/json';
      if (key) headers['Idempotency-Key'] = key;

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new ReapApiError(0, 'NETWORK_ERROR', cause instanceof Error ? cause.message : String(cause));
      }

      const text = await res.text();
      const json: unknown = text ? safeJson(text) : undefined;
      if (res.ok) return json as T;

      const serverError = res.status >= 500;
      const mode = o.onServerError ?? 'retry';
      const retryable = res.status === 429 || (serverError && mode !== 'fail');
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        if (serverError && mode === 'retry-new-key' && o.idempotencyKey) key = `${o.idempotencyKey}:r${attempt + 1}`;
        continue;
      }
      throw ReapApiError.fromResponse(res.status, json);
    }
  }

  searchProducts(req: SearchProductsRequest): Promise<SearchProductsResponse> {
    return this.request('POST', '/agentic/products/search', { body: req });
  }

  getProductDetails(productIds: string[]): Promise<ProductDetailsResponse> {
    return this.request('POST', '/agentic/products/details', { body: { productIds } });
  }

  resolveVariant(req: { productId: string; optionIds: string[] }): Promise<Variant> {
    return this.request('POST', '/agentic/products/variant', { body: req });
  }

  createQuote(req: QuoteRequest, idempotencyKey: string): Promise<Quote> {
    return this.request('POST', '/agentic/quotes', { body: req, idempotencyKey, onServerError: 'retry-new-key' });
  }

  getQuote(id: string): Promise<Quote> {
    return this.request('GET', `/agentic/quotes/${encodeURIComponent(id)}`);
  }

  selectShippingOption(quoteId: string, shippingOptionId: string): Promise<Quote> {
    return this.request('POST', `/agentic/quotes/${encodeURIComponent(quoteId)}/shipping-option`, {
      body: { shippingOptionId },
    });
  }

  createCheckout(req: CheckoutRequest, idempotencyKey: string): Promise<Checkout> {
    return this.request('POST', '/agentic/checkouts', { body: req, idempotencyKey, onServerError: 'fail' });
  }

  getCheckout(id: string): Promise<Checkout> {
    return this.request('GET', `/agentic/checkouts/${encodeURIComponent(id)}`);
  }
}

const backoff = (attempt: number): number => Math.min(8000, 500 * 2 ** attempt);

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'NON_JSON_RESPONSE', message: text.slice(0, 200) } };
  }
}
