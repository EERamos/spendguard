import { randomUUID } from 'node:crypto';
import { round2 } from '../money';
import type { Money } from '../money';
import { ReapApiError } from './errors';
import type {
  Checkout,
  CheckoutRequest,
  CheckoutStatus,
  ProductDetails,
  ProductDetailsResponse,
  ProductSummary,
  Quote,
  QuoteRequest,
  ReapClient,
  SearchProductsRequest,
  SearchProductsResponse,
  ShippingAddress,
  Variant,
} from './types';

/**
 * In-memory stand-in for the Reap Agentic API so the whole product can be built and demoed without keys.
 * Behaviors that matter are modeled: quote expiry, idempotency replay/mismatch, shipping re-pricing,
 * hosted-approval checkout, PROCESSING -> COMPLETED progression and price drift.
 *
 * The catalog uses merchants and test products that appear in the organizers' supported-merchants sheet,
 * so switching to REAP_MODE=live keeps the same demo stories (prices are the sheet's test prices).
 * `giftcards-demo.com` is fictional and exists only to exercise blocked-category rules.
 */

const CURRENCY = 'USD';
const TAX_RATE = 0.085;
const SHIPPING = [
  { id: 'ship_standard', name: 'Standard (3-5 días)', price: 9.99 },
  { id: 'ship_express', name: 'Express (1-2 días)', price: 24.99 },
];

interface MockVariant {
  id: string;
  name: string;
  optionIds: string[];
  price: number;
  available: boolean;
}

interface MockProduct {
  id: string;
  merchant: string;
  name: string;
  keywords: string;
  requiresShipping: boolean;
  options: { name: string; values: { optionId: string; label: string }[] }[];
  variants: MockVariant[];
}

function simple(id: string, merchant: string, name: string, price: number, keywords: string, requiresShipping = true): MockProduct {
  return {
    id,
    merchant,
    name,
    keywords,
    requiresShipping,
    options: [],
    variants: [{ id: `var_${id}`, name, optionIds: [], price, available: true }],
  };
}

export const MOCK_CATALOG: MockProduct[] = [
  simple('p_switches', 'divinikey.com', 'HMX Snowflake Linear Switches - 18 Set', 6.3, 'keyboard switches teclado mecanico interruptores linear'),
  simple('p_powerbank', 'baseus.com', 'Baseus PicoGo AR11 Power Bank 10000mAh 45W', 69.99, 'power bank battery bateria cargador portatil usb-c charger'),
  simple('p_monitor', 'arzopa.com', 'Arzopa Z1C PLUS 17.3in 1080p Portable Monitor', 139.99, 'monitor portable portatil display pantalla'),
  simple('p_dock', 'hypershop.com', 'HyperDrive GEN2 15-in-1 USB-C Docking Station', 299.99, 'docking station dock usb-c hub base'),
  simple('p_cat6', 'gearit.com', '1000ft Bulk Cat6 Outdoor Ethernet Cable DIY Kit', 156.98, 'ethernet cable cat6 red network cableado'),
  simple('p_optiplex', 'computerexchange.com', 'Optiplex SFF 7010', 699.99, 'desktop computer computadora pc optiplex dell'),
  simple('p_headphones', 'headphones.com', 'Lewitt LW6 Wireless Headphones', 699, 'headphones audifonos wireless inalambricos audio'),
  simple('p_towels', 'brooklinen.com', 'Super-Plush Turkish Cotton Hand Towels Set of 2', 33, 'towels toallas bath home hogar oficina'),
  simple('p_flipper', 'flipper.net', 'Flipper Zero', 169, 'flipper zero hacking pentest gadget'),
  simple('p_planter', 'liquiddeath.com', 'Pot Head Planter - Red', 34, 'planter maceta plant decoracion'),
  simple('p_giftcard', 'giftcards-demo.com', 'Gift card $100', 100, 'gift card tarjeta de regalo', false),
  {
    id: 'p_coffee',
    merchant: 'bonescoffee.com',
    name: "Jacked O' Lantern 12oz",
    keywords: 'coffee cafe molido grano beans ground',
    requiresShipping: true,
    options: [
      {
        name: 'Grind',
        values: [
          { optionId: 'opt_coffee_ground', label: 'Ground' },
          { optionId: 'opt_coffee_beans', label: 'Whole Bean' },
        ],
      },
    ],
    variants: [
      { id: 'var_p_coffee_ground', name: 'Ground', optionIds: ['opt_coffee_ground'], price: 17.99, available: true },
      { id: 'var_p_coffee_beans', name: 'Whole Bean', optionIds: ['opt_coffee_beans'], price: 17.99, available: true },
    ],
  },
];

const STOPWORDS = new Set(['de', 'la', 'el', 'los', 'las', 'un', 'una', 'para', 'the', 'a', 'an', 'of', 'for', 'and', 'y', 'con', 'in']);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));

export interface MockOptions {
  publicBaseUrl?: string;
  now?: () => number;
  quoteTtlMs?: number;
  checkoutTtlMs?: number;
  /** How many getCheckout reads return PROCESSING after approval before COMPLETED. Default 1. */
  readsBeforeComplete?: number;
}

interface QuoteRec {
  id: string;
  items: { variantId: string; quantity: number; unit: number; productName: string; merchant: string }[];
  needsShipping: boolean;
  shippingAddress?: ShippingAddress;
  selectedShipping: string;
  subtotal: number;
  discount: number;
  expiresAtMs: number;
}

interface CheckoutRec {
  id: string;
  quoteId: string;
  status: CheckoutStatus;
  amount: Money;
  returnUrl: string;
  createdAtMs: number;
  expiresAtMs: number;
  orderId: string | null;
  readsLeft: number;
  finalAmount?: Money;
  finalOverride?: number;
}

export class MockReapClient implements ReapClient {
  /** Multiplies catalog prices for quotes created from now on. Used to simulate price drift. */
  priceMultiplier = 1;
  /** Number of checkouts actually created (idempotent replays do not count). */
  checkoutCount = 0;

  private readonly quotes = new Map<string, QuoteRec>();
  private readonly checkouts = new Map<string, CheckoutRec>();
  private readonly idem = new Map<string, { fingerprint: string; response: unknown }>();
  private readonly now: () => number;
  private readonly publicBaseUrl: string;
  private readonly quoteTtlMs: number;
  private readonly checkoutTtlMs: number;
  private readonly readsBeforeComplete: number;

  constructor(opts: MockOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.publicBaseUrl = (opts.publicBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
    this.quoteTtlMs = opts.quoteTtlMs ?? 10 * 60_000;
    this.checkoutTtlMs = opts.checkoutTtlMs ?? 30 * 60_000;
    this.readsBeforeComplete = opts.readsBeforeComplete ?? 1;
  }

  // ---------- catalog ----------

  async searchProducts(req: SearchProductsRequest): Promise<SearchProductsResponse> {
    const tokens = tokenize(req.query);
    const minPrice = req.filters?.price?.min !== undefined ? Number(req.filters.price.min) : undefined;
    const maxPrice = req.filters?.price?.max !== undefined ? Number(req.filters.price.max) : undefined;

    const scored = MOCK_CATALOG.map((p) => {
      const haystack = tokenize(`${p.name} ${p.keywords} ${p.merchant}`).join(' ');
      return { p, score: tokens.filter((t) => haystack.includes(t)).length };
    })
      .filter(({ p, score }) => {
        if (score === 0) return false;
        if (req.merchantPreference?.mode === 'ONLY' && p.merchant !== req.merchantPreference.merchantName) return false;
        const price = p.variants[0]!.price;
        if (minPrice !== undefined && price < minPrice) return false;
        if (maxPrice !== undefined && price > maxPrice) return false;
        if (req.filters?.availability === 'AVAILABLE_ONLY' && !p.variants.some((v) => v.available)) return false;
        return true;
      })
      .sort((a, b) => b.score - a.score || a.p.variants[0]!.price - b.p.variants[0]!.price);

    const limit = req.pagination?.limit ?? 10;
    const products = scored.slice(0, limit).map(({ p }) => this.summary(p));
    return {
      id: `search_${randomUUID().slice(0, 8)}`,
      products,
      pagination: { nextCursor: null, hasNextPage: scored.length > limit, returnedCount: products.length },
      warnings: [],
    };
  }

  async getProductDetails(productIds: string[]): Promise<ProductDetailsResponse> {
    const products: ProductDetails[] = [];
    const errors: ProductDetailsResponse['errors'] = [];
    for (const id of productIds) {
      const p = MOCK_CATALOG.find((x) => x.id === id);
      if (!p) {
        errors.push({ productId: id, code: 'AGENTIC_RESOURCE_NOT_FOUND', message: 'Product not found' });
        continue;
      }
      products.push({
        id: p.id,
        merchant: { name: p.merchant },
        name: p.name,
        description: `${p.name} (producto de demostración)`,
        media: [],
        options: p.options.map((o) => ({ name: o.name, values: o.values.map((v) => ({ ...v, available: true })) })),
        defaultVariant: this.variant(p, p.variants[0]!),
      });
    }
    return { products, errors };
  }

  async resolveVariant(req: { productId: string; optionIds: string[] }): Promise<Variant> {
    const p = MOCK_CATALOG.find((x) => x.id === req.productId);
    if (!p) throw new ReapApiError(404, 'AGENTIC_RESOURCE_NOT_FOUND', 'Product not found');
    const wanted = [...req.optionIds].sort().join('|');
    const v = p.variants.find((x) => [...x.optionIds].sort().join('|') === wanted);
    if (!v) throw new ReapApiError(400, 'VARIANT_RESOLUTION_FAILED', 'No variant matches those options');
    return this.variant(p, v);
  }

  // ---------- quotes ----------

  async createQuote(req: QuoteRequest, idempotencyKey: string): Promise<Quote> {
    return this.idempotent('quote', idempotencyKey, req, () => this.render(this.buildQuote(req)));
  }

  async getQuote(id: string): Promise<Quote> {
    return this.render(this.mustQuote(id));
  }

  async selectShippingOption(quoteId: string, shippingOptionId: string): Promise<Quote> {
    const q = this.mustQuote(quoteId);
    if (this.now() >= q.expiresAtMs) throw new ReapApiError(409, 'QUOTE_EXPIRED', 'The quote has expired');
    if (!q.needsShipping || !SHIPPING.some((s) => s.id === shippingOptionId)) {
      throw new ReapApiError(400, 'AGENTIC_REQUEST_REJECTED', 'Unknown shipping option');
    }
    q.selectedShipping = shippingOptionId;
    return this.render(q);
  }

  // ---------- checkouts ----------

  async createCheckout(req: CheckoutRequest, idempotencyKey: string): Promise<Checkout> {
    return this.idempotent('checkout', idempotencyKey, req, () => {
      const q = this.mustQuote(req.quoteId);
      if (this.now() >= q.expiresAtMs) throw new ReapApiError(409, 'QUOTE_EXPIRED', 'The quote has expired');
      const rendered = this.render(q);
      const nowMs = this.now();
      const rec: CheckoutRec = {
        id: `chk_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        quoteId: q.id,
        status: 'REQUIRES_ACTION',
        amount: rendered.amountBreakdown.finalAmount,
        returnUrl: req.presentation.returnUrl,
        createdAtMs: nowMs,
        expiresAtMs: nowMs + this.checkoutTtlMs,
        orderId: null,
        readsLeft: this.readsBeforeComplete,
      };
      this.checkouts.set(rec.id, rec);
      this.checkoutCount += 1;
      return {
        id: rec.id,
        status: rec.status,
        quoteId: rec.quoteId,
        enrollmentId: req.enrollmentId ?? null,
        amount: rec.amount,
        nextAction: {
          type: 'REDIRECT',
          url: `${this.publicBaseUrl}/mock/reap/approve/${rec.id}`,
          expiresAt: new Date(rec.expiresAtMs).toISOString(),
        },
      };
    });
  }

  async getCheckout(id: string): Promise<Checkout> {
    const c = this.mustCheckout(id);
    if (c.status === 'REQUIRES_ACTION' && this.now() >= c.expiresAtMs) c.status = 'EXPIRED';
    if (c.status === 'PROCESSING') {
      if (c.readsLeft > 0) {
        c.readsLeft -= 1;
      } else {
        c.status = 'COMPLETED';
        c.orderId = `ORD-${randomUUID().slice(0, 8).toUpperCase()}`;
        c.finalAmount = { amount: round2(c.finalOverride ?? c.amount.amount), currency: c.amount.currency };
      }
    }
    return {
      id: c.id,
      status: c.status,
      quoteId: c.quoteId,
      amount: c.amount,
      orderId: c.orderId,
      ...(c.finalAmount ? { finalAmount: c.finalAmount } : {}),
      nextAction:
        c.status === 'REQUIRES_ACTION'
          ? {
              type: 'REDIRECT',
              url: `${this.publicBaseUrl}/mock/reap/approve/${c.id}`,
              expiresAt: new Date(c.expiresAtMs).toISOString(),
            }
          : null,
      createdAt: new Date(c.createdAtMs).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  // ---------- simulation hooks (used by the mock approval page and tests) ----------

  /** Simulates the card holder approving on the hosted page. `finalAmount` simulates a different final charge. */
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
    const q = this.mustQuote(c.quoteId);
    return {
      id: c.id,
      status: c.status,
      amount: c.amount,
      returnUrl: c.returnUrl,
      lines: q.items.map((i) => ({ name: i.productName, merchant: i.merchant, quantity: i.quantity, unit: i.unit })),
    };
  }

  // ---------- internals ----------

  private summary(p: MockProduct): ProductSummary {
    const prices = p.variants.map((v) => round2(v.price * this.priceMultiplier));
    const preview = p.variants[0]!;
    return {
      id: p.id,
      merchant: { name: p.merchant },
      name: p.name,
      priceRange: {
        min: { amount: Math.min(...prices), currency: CURRENCY },
        max: { amount: Math.max(...prices), currency: CURRENCY },
      },
      available: p.variants.some((v) => v.available),
      previewVariant: {
        id: preview.id,
        name: preview.name,
        price: { amount: round2(preview.price * this.priceMultiplier), currency: CURRENCY },
        available: preview.available,
      },
    };
  }

  private variant(p: MockProduct, v: MockVariant): Variant {
    return {
      id: v.id,
      name: v.name,
      options: v.optionIds.map((oid) => {
        const group = p.options.find((o) => o.values.some((val) => val.optionId === oid))!;
        return { name: group.name, value: group.values.find((val) => val.optionId === oid)!.label };
      }),
      price: { amount: round2(v.price * this.priceMultiplier), currency: CURRENCY },
      available: v.available,
      requiresShipping: p.requiresShipping,
      media: [],
    };
  }

  private findVariant(variantId: string): { product: MockProduct; variant: MockVariant } | undefined {
    for (const product of MOCK_CATALOG) {
      const variant = product.variants.find((v) => v.id === variantId);
      if (variant) return { product, variant };
    }
    return undefined;
  }

  private buildQuote(req: QuoteRequest): QuoteRec {
    if (req.items.length === 0) throw new ReapApiError(400, 'AGENTIC_REQUEST_REJECTED', 'items is required');
    let subtotal = 0;
    let needsShipping = false;
    const items: QuoteRec['items'] = [];
    for (const item of req.items) {
      const found = this.findVariant(item.variantId);
      if (!found) throw new ReapApiError(404, 'AGENTIC_RESOURCE_NOT_FOUND', `Variant ${item.variantId} not found`);
      if (!found.variant.available) throw new ReapApiError(409, 'VARIANT_UNAVAILABLE', 'The selected item is sold out');
      const unit = round2(found.variant.price * this.priceMultiplier);
      subtotal += unit * item.quantity;
      if (found.product.requiresShipping) needsShipping = true;
      items.push({
        variantId: item.variantId,
        quantity: item.quantity,
        unit,
        productName: found.product.name,
        merchant: found.product.merchant,
      });
    }
    if (needsShipping && !req.shippingAddress) {
      throw new ReapApiError(400, 'AGENTIC_REQUEST_REJECTED', 'shippingAddress is required when any item requires shipping');
    }
    let discount = 0;
    if (req.offerCode) {
      if (req.offerCode.toUpperCase() !== 'SAVE10') throw new ReapApiError(400, 'OFFER_CODE_INVALID', 'The offer code is invalid');
      discount = subtotal * 0.1;
    }
    const rec: QuoteRec = {
      id: `quo_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      items,
      needsShipping,
      shippingAddress: req.shippingAddress,
      selectedShipping: SHIPPING[0]!.id,
      subtotal: round2(subtotal),
      discount: round2(discount),
      expiresAtMs: this.now() + this.quoteTtlMs,
    };
    this.quotes.set(rec.id, rec);
    return rec;
  }

  private render(q: QuoteRec): Quote {
    const money = (amount: number): Money => ({ amount: round2(amount), currency: CURRENCY });
    const shippingPrice = q.needsShipping ? (SHIPPING.find((s) => s.id === q.selectedShipping)?.price ?? 0) : 0;
    const taxable = q.subtotal - q.discount;
    const tax = round2(taxable * TAX_RATE);
    const final = round2(taxable + shippingPrice + tax);
    return {
      id: q.id,
      shippingOptions: q.needsShipping
        ? SHIPPING.map((s) => ({ id: s.id, name: s.name, selected: s.id === q.selectedShipping, price: money(s.price) }))
        : [],
      amountBreakdown: {
        itemsSubtotal: money(q.subtotal),
        shipping: money(shippingPrice),
        tax: { amount: money(tax), includedInPrices: false },
        discounts: q.discount > 0 ? [{ name: 'SAVE10', amount: money(q.discount) }] : [],
        additionalCharges: [],
        finalAmount: money(final),
      },
      expiresAt: new Date(q.expiresAtMs).toISOString(),
    };
  }

  private mustQuote(id: string): QuoteRec {
    const q = this.quotes.get(id);
    if (!q) throw new ReapApiError(404, 'AGENTIC_RESOURCE_NOT_FOUND', `Quote ${id} not found`);
    return q;
  }

  private mustCheckout(id: string): CheckoutRec {
    const c = this.checkouts.get(id);
    if (!c) throw new ReapApiError(404, 'AGENTIC_RESOURCE_NOT_FOUND', `Checkout ${id} not found`);
    return c;
  }

  /** Mimics Reap's Idempotency-Key: same key + same body replays, same key + different body is rejected. */
  private idempotent<T>(scope: string, key: string, body: unknown, create: () => T): T {
    const k = `${scope}:${key}`;
    const fingerprint = JSON.stringify(body);
    const hit = this.idem.get(k);
    if (hit) {
      if (hit.fingerprint !== fingerprint) {
        throw new ReapApiError(400, 'IDEMPOTENT_PARAMETER_MISMATCH', 'Idempotency-Key reused with a different request body');
      }
      return structuredClone(hit.response as T);
    }
    const out = create();
    this.idem.set(k, { fingerprint, response: structuredClone(out) });
    return out;
  }
}
