import { randomUUID } from 'node:crypto';
import { round2 } from '../money';
import type { Money } from '../money';
import { ReapApiError } from './errors';
import type {
  Checkout,
  CheckoutRequest,
  CheckoutStatus,
  ProductDetailsResponse,
  Quote,
  QuoteRequest,
  ReapClient,
  SearchProductsRequest,
  SearchProductsResponse,
  Variant,
} from './types';

interface CheckoutRec {
  id: string;
  quoteId: string;
  status: CheckoutStatus;
  amount: Money;
  breakdown: Quote['amountBreakdown'];
  returnUrl: string;
  createdAtMs: number;
  expiresAtMs: number;
  orderId: string | null;
  finalAmount?: Money;
  finalOverride?: number;
}

/**
 * Live Reap for discovery and pricing (search, details, variant, quote); simulated card-holder approval for the charge.
 *
 * For sandbox sessions where no Reap enrollment could be activated. Everything the policy judges is still Reap's
 * real quote; only the hosted approval page and the resulting order are simulated, and the page says so.
 * Exposes the same simulation hooks as MockReapClient so the same approval page serves both.
 */
export class HybridReapClient implements ReapClient {
  private readonly checkouts = new Map<string, CheckoutRec>();
  private readonly byKey = new Map<string, string>();
  private readonly publicBaseUrl: string;
  private readonly now: () => number;
  private readonly checkoutTtlMs: number;

  constructor(
    private readonly live: ReapClient,
    opts: { publicBaseUrl: string; now?: () => number; checkoutTtlMs?: number },
  ) {
    this.publicBaseUrl = opts.publicBaseUrl.replace(/\/$/, '');
    this.now = opts.now ?? Date.now;
    this.checkoutTtlMs = opts.checkoutTtlMs ?? 30 * 60_000;
  }

  // ---------- live: discovery and pricing ----------

  searchProducts(req: SearchProductsRequest): Promise<SearchProductsResponse> {
    return this.live.searchProducts(req);
  }

  getProductDetails(productIds: string[]): Promise<ProductDetailsResponse> {
    return this.live.getProductDetails(productIds);
  }

  resolveVariant(req: { productId: string; optionIds: string[] }): Promise<Variant> {
    return this.live.resolveVariant(req);
  }

  createQuote(req: QuoteRequest, idempotencyKey: string): Promise<Quote> {
    return this.live.createQuote(req, idempotencyKey);
  }

  getQuote(id: string): Promise<Quote> {
    return this.live.getQuote(id);
  }

  selectShippingOption(quoteId: string, shippingOptionId: string): Promise<Quote> {
    return this.live.selectShippingOption(quoteId, shippingOptionId);
  }

  // ---------- simulated: checkout ----------

  async createCheckout(req: CheckoutRequest, idempotencyKey: string): Promise<Checkout> {
    const existing = this.byKey.get(idempotencyKey);
    if (existing) return this.view(this.mustCheckout(existing));

    // The quote is read back from Reap: the simulated charge is for the amount Reap priced, and only while it is valid.
    const quote = await this.live.getQuote(req.quoteId);
    const nowMs = this.now();
    if (nowMs >= Date.parse(quote.expiresAt)) throw new ReapApiError(409, 'QUOTE_EXPIRED', 'The quote has expired');

    const rec: CheckoutRec = {
      id: `chk_sim_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      quoteId: req.quoteId,
      status: 'REQUIRES_ACTION',
      amount: quote.amountBreakdown.finalAmount,
      breakdown: quote.amountBreakdown,
      returnUrl: req.presentation.returnUrl,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.checkoutTtlMs,
      orderId: null,
    };
    this.checkouts.set(rec.id, rec);
    this.byKey.set(idempotencyKey, rec.id);
    return this.view(rec);
  }

  async getCheckout(id: string): Promise<Checkout> {
    const c = this.mustCheckout(id);
    if (c.status === 'REQUIRES_ACTION' && this.now() >= c.expiresAtMs) c.status = 'EXPIRED';
    if (c.status === 'PROCESSING') {
      c.status = 'COMPLETED';
      c.orderId = `SIM-${randomUUID().slice(0, 8).toUpperCase()}`;
      c.finalAmount = { amount: round2(c.finalOverride ?? c.amount.amount), currency: c.amount.currency };
    }
    return this.view(c);
  }

  // ---------- simulation hooks (used by the approval page) ----------

  approveCheckout(id: string, opts: { finalAmount?: number } = {}): { returnUrl: string } {
    const c = this.mustCheckout(id);
    if (c.status !== 'REQUIRES_ACTION') throw new ReapApiError(409, 'CHECKOUT_NOT_APPROVABLE', `Checkout is ${c.status}`);
    if (this.now() >= c.expiresAtMs) {
      c.status = 'EXPIRED';
      throw new ReapApiError(409, 'CHECKOUT_EXPIRED', 'Checkout approval window passed');
    }
    c.status = 'PROCESSING';
    c.finalOverride = opts.finalAmount;
    return { returnUrl: c.returnUrl };
  }

  failCheckout(id: string): { returnUrl: string } {
    const c = this.mustCheckout(id);
    c.status = 'FAILED';
    return { returnUrl: c.returnUrl };
  }

  describeCheckout(id: string) {
    const c = this.mustCheckout(id);
    const b = c.breakdown;
    const source = `Cotización real de Reap ${c.quoteId}`;
    const lines = [{ name: 'Productos', merchant: source, quantity: 1, unit: b.itemsSubtotal.amount }];
    if (b.shipping) lines.push({ name: 'Envío', merchant: source, quantity: 1, unit: b.shipping.amount });
    if (b.tax && !b.tax.includedInPrices) lines.push({ name: 'Impuestos', merchant: source, quantity: 1, unit: b.tax.amount.amount });
    return { id: c.id, status: c.status, amount: c.amount, returnUrl: c.returnUrl, lines };
  }

  // ---------- internals ----------

  private mustCheckout(id: string): CheckoutRec {
    const c = this.checkouts.get(id);
    if (!c) throw new ReapApiError(404, 'AGENTIC_RESOURCE_NOT_FOUND', `Checkout ${id} not found`);
    return c;
  }

  private view(c: CheckoutRec): Checkout {
    return {
      id: c.id,
      status: c.status,
      quoteId: c.quoteId,
      enrollmentId: null,
      amount: c.amount,
      orderId: c.orderId,
      ...(c.finalAmount ? { finalAmount: c.finalAmount } : {}),
      nextAction:
        c.status === 'REQUIRES_ACTION'
          ? { type: 'REDIRECT', url: `${this.publicBaseUrl}/mock/reap/approve/${c.id}`, expiresAt: new Date(c.expiresAtMs).toISOString() }
          : null,
      createdAt: new Date(c.createdAtMs).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    };
  }
}
