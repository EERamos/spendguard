import { round2 } from '../money';
import type { Money } from '../money';
import { monthKey, spendFor } from '../domain/ledger';
import type { Policy, PolicyProvider } from '../domain/policy';
import { blockedKeyword, evaluate, merchantVerdict } from '../domain/policy-engine';
import type { EvaluationInput } from '../domain/policy-engine';
import type { AuditEvent, PolicyDecision, PurchaseRequest, QuoteSnapshot, Requester } from '../domain/types';
import { ReapApiError } from '../reap/errors';
import type { Checkout, ProductDetails, Quote, ReapClient, ShippingAddress, Variant } from '../reap/types';
import type { ListFilter, Store } from '../store/store';
import { DomainError } from '../util/errors';
import { newId } from '../util/id';
import { Mutex } from '../util/mutex';

/**
 * PurchaseService is the only place where policy, budget and Reap meet. Invariants it enforces:
 *
 *  1. The agent never decides a price, a merchant or a category. Product name, merchant and variant are
 *     re-fetched from Reap, and the amount that gets judged is the one inside the Reap quote.
 *  2. "Read spend -> evaluate policy -> reserve budget" is atomic (mutex), so parallel agents cannot overspend.
 *  3. A Reap checkout (and therefore a payment link) exists only after the policy allowed it:
 *     automatically (AUTO_APPROVE) or because an authorized human approved it (REQUIRE_APPROVAL).
 *  4. Reap idempotency keys are deterministic, so retries and crash recovery can never create two checkouts.
 *  5. After the card holder pays on the Reap page, the order is reconciled against the quote.
 */

/** Quotes closer to expiry than this are refreshed before opening the checkout. */
const REQUOTE_MARGIN_MS = 15_000;

/** Reap checkout states can only move forward; used to ignore stale polls. */
const CHECKOUT_RANK: Record<string, number> = { REQUIRES_ACTION: 0, PROCESSING: 1 };

type CheckoutState = NonNullable<PurchaseRequest['checkout']>;

type Evaluable = Pick<PurchaseRequest, 'departmentId' | 'requester' | 'justification' | 'searchText' | 'declaredMaxTotal' | 'item'>;

export interface PurchaseServiceDeps {
  store: Store;
  reap: ReapClient;
  policy: PolicyProvider;
  /** Where Reap sends the card holder back after the hosted approval page. */
  publicBaseUrl: string;
  /** Used when a request does not carry its own shipping address. */
  defaultShipping: ShippingAddress;
  /** Epoch ms. Injectable for tests. */
  now?: () => number;
}

export interface SearchOptions {
  maxPrice?: number;
  limit?: number;
  merchant?: string;
}

export interface ProductListing {
  productId: string;
  name: string;
  merchant: string;
  minPrice: Money;
  maxPrice: Money;
  defaultVariantId?: string;
  available: boolean;
}

export interface FilteredProduct {
  productId: string;
  name: string;
  merchant: string;
  rule: 'MERCHANT_BLOCKED' | 'MERCHANT_NOT_ALLOWLISTED' | 'KEYWORD_BLOCKED';
  message: string;
}

export interface SearchOutcome {
  products: ProductListing[];
  /** Results Reap returned that policy would deny anyway; shown so the requester understands why they are missing. */
  filteredOut: FilteredProduct[];
  warnings: string[];
}

export interface ProductView {
  productId: string;
  name: string;
  merchant: string;
  description?: string;
  options: ProductDetails['options'];
  defaultVariant: {
    id: string;
    name?: string;
    price: Money;
    available: boolean;
    requiresShipping: boolean;
    options: Variant['options'];
  };
}

export interface ProposeInput {
  requester: Requester;
  departmentId: string;
  justification: string;
  productId: string;
  /** Reap option ids picked from the product's options. Omit for the default variant. */
  optionIds?: string[];
  quantity: number;
  /** What the requester expects to pay in total; a quote far above it needs a human. */
  declaredMaxTotal?: number;
  shippingAddress?: ShippingAddress;
  shippingOptionId?: string;
  offerCode?: string;
  searchText?: string;
  clientRef?: string;
}

export interface BudgetRow {
  departmentId: string;
  name: string;
  month: string;
  currency: string;
  monthlyBudget: number;
  committed: number;
  reserved: number;
  remaining: number;
  autoApproveUnder: number;
  hardCapPerPurchase: number;
  approvers: string[];
}

export interface ReconcileSummary {
  checked: number;
  changed: number;
  errors: { requestId: string; message: string }[];
}

/** Network trouble and rate limits are not cached by Reap, so retrying the same call later is safe. */
const isTransient = (e: ReapApiError): boolean => e.status === 0 || e.status === 429;

function checkoutState(c: Checkout): CheckoutState {
  return {
    id: c.id,
    status: c.status,
    ...(c.nextAction?.url ? { paymentUrl: c.nextAction.url } : {}),
    ...(c.nextAction?.expiresAt ? { paymentUrlExpiresAt: c.nextAction.expiresAt } : {}),
    orderId: c.orderId ?? null,
    ...(c.finalAmount ? { finalAmount: c.finalAmount } : {}),
  };
}

export class PurchaseService {
  private readonly mutex = new Mutex();
  private readonly store: Store;
  private readonly reap: ReapClient;
  private readonly policy: PolicyProvider;
  private readonly publicBaseUrl: string;
  private readonly defaultShipping: ShippingAddress;
  private readonly now: () => number;

  constructor(deps: PurchaseServiceDeps) {
    this.store = deps.store;
    this.reap = deps.reap;
    this.policy = deps.policy;
    this.publicBaseUrl = deps.publicBaseUrl.replace(/\/$/, '');
    this.defaultShipping = deps.defaultShipping;
    this.now = deps.now ?? Date.now;
  }

  // ------------------------------------------------------------------ catalog

  async searchProducts(query: string, opts: SearchOptions = {}): Promise<SearchOutcome> {
    const q = query.trim();
    if (!q) throw new DomainError('EMPTY_QUERY', 'La búsqueda no puede estar vacía', 400);

    const res = await this.reap.searchProducts({
      query: q,
      ...(opts.merchant ? { merchantPreference: { mode: 'PREFER' as const, merchantName: opts.merchant } } : {}),
      filters: {
        availability: 'AVAILABLE_ONLY',
        ...(opts.maxPrice !== undefined ? { price: { max: String(opts.maxPrice) } } : {}),
      },
      pagination: { limit: opts.limit ?? 10 },
    });

    const policy = this.policy.get();
    const products: ProductListing[] = [];
    const filteredOut: FilteredProduct[] = [];
    for (const p of res.products) {
      const merchant = p.merchant.name;
      const base = { productId: p.id, name: p.name, merchant };
      const verdict = merchantVerdict(merchant, policy);
      const keyword = blockedKeyword(`${p.name} ${q}`, policy);
      if (verdict === 'BLOCKED') {
        filteredOut.push({ ...base, rule: 'MERCHANT_BLOCKED', message: `El merchant "${merchant}" está bloqueado por política` });
      } else if (verdict === 'NOT_ALLOWLISTED') {
        filteredOut.push({ ...base, rule: 'MERCHANT_NOT_ALLOWLISTED', message: `El merchant "${merchant}" no está en la lista de permitidos` });
      } else if (keyword) {
        filteredOut.push({ ...base, rule: 'KEYWORD_BLOCKED', message: `Coincide con una categoría bloqueada ("${keyword}")` });
      } else {
        products.push({
          ...base,
          minPrice: p.priceRange.min,
          maxPrice: p.priceRange.max,
          ...(p.previewVariant?.id ? { defaultVariantId: p.previewVariant.id } : {}),
          available: p.available !== false,
        });
      }
    }
    return { products, filteredOut, warnings: res.warnings ?? [] };
  }

  async getProduct(productId: string): Promise<ProductView> {
    const d = await this.fetchProduct(productId);
    return {
      productId: d.id,
      name: d.name,
      merchant: d.merchant.name,
      ...(d.description ? { description: d.description } : {}),
      options: d.options,
      defaultVariant: {
        id: d.defaultVariant.id,
        ...(d.defaultVariant.name ? { name: d.defaultVariant.name } : {}),
        price: d.defaultVariant.price,
        available: d.defaultVariant.available !== false,
        requiresShipping: d.defaultVariant.requiresShipping !== false,
        options: d.defaultVariant.options,
      },
    };
  }

  resolveVariant(productId: string, optionIds: string[]): Promise<Variant> {
    return this.reap.resolveVariant({ productId, optionIds });
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Turns "an agent wants to buy X" into a policy-checked request:
   * quote it with Reap, judge the quoted total, reserve the budget and (only if allowed) open the checkout.
   */
  async propose(input: ProposeInput): Promise<PurchaseRequest> {
    const start = this.policy.get();
    if (!start.departments[input.departmentId]) {
      throw new DomainError(
        'UNKNOWN_DEPARTMENT',
        `Departamento desconocido: "${input.departmentId}". Disponibles: ${Object.keys(start.departments).join(', ')}`,
        400,
      );
    }
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw new DomainError('INVALID_QUANTITY', 'La cantidad debe ser un entero mayor o igual a 1', 400);
    }
    if (input.clientRef) {
      const existing = this.findByClientRef(input.clientRef, input.requester.email);
      if (existing) return existing;
    }

    // Trust Reap, not the caller, for what is being bought. The variant is resolved from the product,
    // so an agent cannot pair an allowed product with a variant of a blocked one.
    const product = await this.fetchProduct(input.productId);
    const variant = await this.pickVariant(product, input.optionIds);
    if (variant.available === false) {
      throw new DomainError('VARIANT_UNAVAILABLE', `"${product.name}" no está disponible en la variante elegida`, 409);
    }

    const id = newId('req');
    const shipping = variant.requiresShipping === false ? undefined : (input.shippingAddress ?? this.defaultShipping);
    let quote = await this.reap.createQuote(
      {
        email: input.requester.email,
        items: [{ variantId: variant.id, quantity: input.quantity }],
        ...(shipping ? { shippingAddress: shipping } : {}),
        ...(input.offerCode ? { offerCode: input.offerCode } : {}),
      },
      `quote:${id}:1`,
    );
    if (input.shippingOptionId) quote = await this.reap.selectShippingOption(quote.id, input.shippingOptionId);

    const snapshot = this.snapshot(quote, 1);
    const subtotal = quote.amountBreakdown.itemsSubtotal;
    const productName = variant.options.length > 0 ? `${product.name} (${variant.options.map((o) => o.value).join(', ')})` : product.name;

    return this.mutex.run(async () => {
      if (input.clientRef) {
        const existing = this.findByClientRef(input.clientRef, input.requester.email);
        if (existing) return existing;
      }

      const policy = this.policy.get();
      const createdAt = this.iso();
      const base: Omit<PurchaseRequest, 'decision' | 'status'> = {
        id,
        createdAt,
        updatedAt: createdAt,
        requester: input.requester,
        departmentId: input.departmentId,
        justification: input.justification,
        ...(input.searchText ? { searchText: input.searchText } : {}),
        ...(input.declaredMaxTotal !== undefined ? { declaredMaxTotal: input.declaredMaxTotal } : {}),
        ...(input.offerCode ? { offerCode: input.offerCode } : {}),
        ...(input.clientRef ? { clientRef: input.clientRef } : {}),
        ...(shipping ? { shippingAddress: shipping } : {}),
        item: {
          productId: product.id,
          productName,
          merchant: product.merchant.name,
          variantId: variant.id,
          quantity: input.quantity,
          unitPrice: { amount: round2(subtotal.amount / input.quantity), currency: subtotal.currency },
        },
        quote: snapshot,
      };

      const spend = spendFor(this.store.list({ departmentId: input.departmentId }), input.departmentId, monthKey(createdAt), policy);
      const decision = evaluate(this.evaluationInput(base, snapshot.total), policy, spend);

      let request: PurchaseRequest = { ...base, decision, status: decision.outcome === 'DENY' ? 'DENIED' : 'PENDING_APPROVAL' };
      let opened: Checkout | undefined;
      let checkoutError: ReapApiError | undefined;

      if (decision.outcome === 'AUTO_APPROVE') {
        try {
          opened = await this.openCheckout(request);
          request = { ...request, status: 'AWAITING_PAYMENT', checkout: checkoutState(opened) };
        } catch (e) {
          if (!(e instanceof ReapApiError)) throw e;
          checkoutError = e;
          request = { ...request, status: 'FAILED', failure: { code: `REAP_${e.code}`, message: e.message } };
        }
      }

      this.store.insert(request);
      this.log(id, input.requester.email, 'REQUEST_CREATED', {
        departmentId: input.departmentId,
        item: request.item,
        justification: input.justification,
        ...(input.declaredMaxTotal !== undefined ? { declaredMaxTotal: input.declaredMaxTotal } : {}),
      });
      this.log(id, 'reap', 'QUOTE_CREATED', { quoteId: snapshot.id, total: snapshot.total, expiresAt: snapshot.expiresAt });
      this.log(id, 'policy-engine', 'POLICY_EVALUATED', decision);
      if (decision.outcome === 'REQUIRE_APPROVAL') {
        this.log(id, 'policy-engine', 'APPROVAL_REQUESTED', { approvers: policy.departments[input.departmentId]?.approvers ?? [] });
      }
      if (opened) {
        this.log(id, 'policy-engine', 'AUTO_APPROVED', { total: snapshot.total });
        this.log(id, 'reap', 'CHECKOUT_CREATED', { checkoutId: opened.id, status: opened.status });
      }
      if (checkoutError) this.log(id, 'reap', 'CHECKOUT_FAILED', this.errorData(checkoutError));
      return request;
    });
  }

  /**
   * An authorized human accepts the purchase. Re-validates everything that may have changed while it waited
   * (policy, budget, quote expiry, price) before opening the Reap checkout.
   */
  approve(id: string, actorEmail: string, note?: string): Promise<PurchaseRequest> {
    return this.mutex.run(async () => {
      const req = this.mustGet(id);
      this.assertState(req, 'PENDING_APPROVAL', 'aprobar');
      const policy = this.policy.get();
      this.assertApprover(actorEmail, req, policy, true);

      // The total the approver was looking at when they clicked.
      const approvedTotal = req.quote.total;
      let quote = req.quote;

      if (!(Date.parse(quote.expiresAt) - this.now() >= REQUOTE_MARGIN_MS)) {
        let fresh: QuoteSnapshot;
        try {
          fresh = await this.requote(req);
        } catch (e) {
          return this.handleReapFailure(req, e, 'QUOTE_FAILED');
        }
        this.log(id, 'reap', 'QUOTE_REFRESHED', { from: quote.id, to: fresh.id, oldTotal: quote.total, newTotal: fresh.total });
        if (this.priceRoseBeyondTolerance(approvedTotal, fresh.total, policy)) {
          this.mutate(id, (d) => {
            d.quote = fresh;
          });
          this.log(id, 'system', 'PRICE_CHANGED', { approvedTotal, newTotal: fresh.total, tolerancePct: policy.priceTolerancePct });
          throw new DomainError(
            'PRICE_CHANGED',
            `El precio cambió mientras esperaba aprobación (${approvedTotal.amount.toFixed(2)} → ${fresh.total.amount.toFixed(2)} ${fresh.total.currency}). Revisa y vuelve a aprobar.`,
            409,
            { approvedTotal, newTotal: fresh.total },
          );
        }
        quote = fresh;
        this.mutate(id, (d) => {
          d.quote = fresh;
        });
      }

      // Same rules, current world: policy may have changed and other requests may have used budget.
      const spend = spendFor(
        this.store.list({ departmentId: req.departmentId }),
        req.departmentId,
        monthKey(req.createdAt),
        policy,
        req.id,
      );
      const decision = evaluate(this.evaluationInput(req, quote.total), policy, spend);
      this.log(id, 'policy-engine', 'POLICY_EVALUATED', { ...decision, trigger: 'approval' });
      if (decision.outcome === 'DENY') {
        const denied = this.mutate(id, (d) => {
          d.status = 'DENIED';
          d.decision = decision;
        });
        this.log(id, 'system', 'APPROVAL_BLOCKED', {
          approver: actorEmail,
          reasons: decision.hits.filter((h) => h.outcome === 'DENY').map((h) => h.message),
        });
        return denied;
      }

      const candidate: PurchaseRequest = { ...req, quote };
      let checkout: Checkout;
      try {
        checkout = await this.openCheckout(candidate);
      } catch (e) {
        return this.handleReapFailure(candidate, e, 'CHECKOUT_FAILED');
      }

      const approved = this.mutate(id, (d) => {
        d.status = 'AWAITING_PAYMENT';
        d.decision = decision;
        d.approval = { by: actorEmail, at: this.iso(), ...(note ? { note } : {}), approvedTotal };
        d.checkout = checkoutState(checkout);
      });
      this.log(id, actorEmail, 'APPROVED', { ...(note ? { note } : {}), approvedTotal, checkoutTotal: quote.total });
      this.log(id, 'reap', 'CHECKOUT_CREATED', { checkoutId: checkout.id, status: checkout.status });
      return approved;
    });
  }

  reject(id: string, actorEmail: string, reason: string): Promise<PurchaseRequest> {
    return this.mutex.run(async () => {
      const req = this.mustGet(id);
      this.assertState(req, 'PENDING_APPROVAL', 'rechazar');
      this.assertApprover(actorEmail, req, this.policy.get(), false);
      const rejected = this.mutate(id, (d) => {
        d.status = 'REJECTED';
        d.rejection = { by: actorEmail, at: this.iso(), reason };
      });
      this.log(id, actorEmail, 'REJECTED', { reason });
      return rejected;
    });
  }

  /** The requester (or an approver) withdraws a request that is still waiting for approval. */
  cancel(id: string, actorEmail: string): Promise<PurchaseRequest> {
    return this.mutex.run(async () => {
      const req = this.mustGet(id);
      this.assertState(req, 'PENDING_APPROVAL', 'cancelar');
      if (actorEmail.trim().toLowerCase() !== req.requester.email.toLowerCase()) {
        this.assertApprover(actorEmail, req, this.policy.get(), false);
      }
      const cancelled = this.mutate(id, (d) => {
        d.status = 'CANCELLED';
      });
      this.log(id, actorEmail, 'CANCELLED', {});
      return cancelled;
    });
  }

  /** Asks Reap where the checkout stands and applies it. Returning from the Reap page does NOT mean the order exists. */
  async refresh(id: string): Promise<PurchaseRequest> {
    const req = this.mustGet(id);
    if (req.status !== 'AWAITING_PAYMENT' || !req.checkout) return req;
    const remote = await this.reap.getCheckout(req.checkout.id);
    return this.mutex.run(async () => this.applyCheckout(id, remote));
  }

  /** Polls every open checkout. Safe to call from a timer: one failing request does not stop the rest. */
  async reconcileOpen(): Promise<ReconcileSummary> {
    const open = this.store.list({ status: ['AWAITING_PAYMENT'] });
    const summary: ReconcileSummary = { checked: open.length, changed: 0, errors: [] };
    for (const r of open) {
      try {
        const after = await this.refresh(r.id);
        if (after.status !== r.status || after.checkout?.status !== r.checkout?.status) summary.changed += 1;
      } catch (e) {
        summary.errors.push({ requestId: r.id, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return summary;
  }

  // ------------------------------------------------------------------ reads

  get(id: string): PurchaseRequest {
    return this.mustGet(id);
  }

  list(filter?: ListFilter): PurchaseRequest[] {
    return this.store.list(filter);
  }

  audit(requestId?: string): AuditEvent[] {
    return this.store.listAudit(requestId);
  }

  budgets(month: string = monthKey(this.iso())): BudgetRow[] {
    const policy = this.policy.get();
    const all = this.store.list();
    return Object.entries(policy.departments).map(([departmentId, d]) => {
      const spend = spendFor(all, departmentId, month, policy);
      return {
        departmentId,
        name: d.name,
        month,
        currency: policy.baseCurrency,
        monthlyBudget: d.monthlyBudget,
        committed: spend.committed,
        reserved: spend.reserved,
        remaining: round2(d.monthlyBudget - spend.committed - spend.reserved),
        autoApproveUnder: d.autoApproveUnder,
        hardCapPerPurchase: d.hardCapPerPurchase,
        approvers: d.approvers,
      };
    });
  }

  getPolicy(): Policy {
    return this.policy.get();
  }

  updatePolicy(next: unknown, actorEmail: string): Policy {
    const before = this.policy.get().version;
    const updated = this.policy.replace(next);
    this.log(null, actorEmail, 'POLICY_UPDATED', { fromVersion: before, toVersion: updated.version });
    return updated;
  }

  // ------------------------------------------------------------------ internals

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private log(requestId: string | null, actor: string, type: string, data?: unknown): void {
    this.store.appendAudit({ at: this.iso(), requestId, actor, type, ...(data !== undefined ? { data } : {}) });
  }

  private errorData(e: ReapApiError): { code: string; status: number; message: string } {
    return { code: e.code, status: e.status, message: e.message };
  }

  private mustGet(id: string): PurchaseRequest {
    const r = this.store.get(id);
    if (!r) throw new DomainError('REQUEST_NOT_FOUND', `Solicitud ${id} no existe`, 404);
    return r;
  }

  private mutate(id: string, fn: (draft: PurchaseRequest) => void): PurchaseRequest {
    return this.store.update(id, (d) => {
      fn(d);
      d.updatedAt = this.iso();
    });
  }

  /**
   * Scoped to the requester: a clientRef is a retry key, not a lookup key, so another requester reusing
   * (or guessing) it must not get someone else's request and its payment link back.
   */
  private findByClientRef(ref: string, requesterEmail: string): PurchaseRequest | undefined {
    const email = requesterEmail.trim().toLowerCase();
    return this.store.list().find((r) => r.clientRef === ref && r.requester.email.trim().toLowerCase() === email);
  }

  private assertState(req: PurchaseRequest, expected: PurchaseRequest['status'], verb: string): void {
    if (req.status !== expected) {
      throw new DomainError('INVALID_STATE', `No se puede ${verb} una solicitud en estado ${req.status} (se requiere ${expected})`, 409);
    }
  }

  /** Authorization is by email here (no login in the demo); put real authentication in front of the API in production. */
  private assertApprover(actorEmail: string, req: PurchaseRequest, policy: Policy, forApproval: boolean): void {
    const actor = actorEmail.trim().toLowerCase();
    if (!actor) throw new DomainError('ACTOR_REQUIRED', 'Falta el email de quien actúa', 400);
    const dept = policy.departments[req.departmentId];
    const approvers = (dept?.approvers ?? []).map((a) => a.toLowerCase());
    if (approvers.length > 0 && !approvers.includes(actor)) {
      throw new DomainError('NOT_AN_APPROVER', `${actorEmail} no es aprobador de ${dept?.name ?? req.departmentId}`, 403);
    }
    if (forApproval && !policy.allowSelfApproval && actor === req.requester.email.toLowerCase()) {
      throw new DomainError('SELF_APPROVAL_FORBIDDEN', 'No puedes aprobar tu propia solicitud (separación de funciones)', 403);
    }
  }

  private evaluationInput(r: Evaluable, total: Money): EvaluationInput {
    return {
      departmentId: r.departmentId,
      requesterEmail: r.requester.email,
      justification: r.justification,
      merchant: r.item.merchant,
      productName: r.item.productName,
      searchText: r.searchText,
      quantity: r.item.quantity,
      total,
      declaredMaxTotal: r.declaredMaxTotal,
    };
  }

  private snapshot(q: Quote, attempt: number): QuoteSnapshot {
    return {
      id: q.id,
      attempt,
      createdAt: this.iso(),
      expiresAt: q.expiresAt,
      total: q.amountBreakdown.finalAmount,
      breakdown: q.amountBreakdown,
      shippingOptions: q.shippingOptions,
    };
  }

  private priceRoseBeyondTolerance(approved: Money, current: Money, policy: Policy): boolean {
    if (approved.currency !== current.currency) return true;
    return current.amount > approved.amount * (1 + policy.priceTolerancePct / 100);
  }

  private async fetchProduct(productId: string): Promise<ProductDetails> {
    const res = await this.reap.getProductDetails([productId]);
    const product = res.products.find((p) => p.id === productId);
    if (!product) {
      const reason = res.errors[0]?.message;
      throw new DomainError('PRODUCT_NOT_FOUND', `Producto ${productId} no encontrado${reason ? `: ${reason}` : ''}`, 404);
    }
    return product;
  }

  private pickVariant(product: ProductDetails, optionIds?: string[]): Promise<Variant> | Variant {
    if (!optionIds || optionIds.length === 0) return product.defaultVariant;
    return this.reap.resolveVariant({ productId: product.id, optionIds });
  }

  /** Quotes are re-created with a fresh attempt number (and failure count) so a cached 5xx can never wedge an approval. */
  private async requote(req: PurchaseRequest): Promise<QuoteSnapshot> {
    const attempt = req.quote.attempt + 1;
    const failures = this.store.listAudit(req.id).filter((e) => e.type === 'QUOTE_FAILED').length;
    let q = await this.reap.createQuote(
      {
        email: req.requester.email,
        items: [{ variantId: req.item.variantId, quantity: req.item.quantity }],
        ...(req.shippingAddress ? { shippingAddress: req.shippingAddress } : {}),
        ...(req.offerCode ? { offerCode: req.offerCode } : {}),
      },
      `quote:${req.id}:${attempt}${failures > 0 ? `:f${failures}` : ''}`,
    );
    // Keep the shipping method the first quote was using.
    const wanted = req.quote.shippingOptions.find((o) => o.selected)?.id;
    const current = q.shippingOptions.find((o) => o.selected)?.id;
    if (wanted && wanted !== current && q.shippingOptions.some((o) => o.id === wanted)) {
      q = await this.reap.selectShippingOption(q.id, wanted);
    }
    return this.snapshot(q, attempt);
  }

  private openCheckout(r: PurchaseRequest): Promise<Checkout> {
    return this.reap.createCheckout(
      {
        quoteId: r.quote.id,
        owner: { type: 'CLIENT_REFERENCE', reference: r.requester.id, email: r.requester.email },
        presentation: { type: 'REDIRECT', returnUrl: `${this.publicBaseUrl}/return/${r.id}` },
      },
      // Deterministic: retrying the same request+quote can never open a second checkout.
      `checkout:${r.id}:${r.quote.id}`,
    );
  }

  /**
   * A Reap call failed while a human was approving.
   *  - Transient (network, rate limit): leave the request pending so the approver can retry; the same key is safe.
   *  - Anything else: the purchase cannot proceed, so close it (this also releases the reserved budget).
   */
  private handleReapFailure(req: PurchaseRequest, e: unknown, type: 'QUOTE_FAILED' | 'CHECKOUT_FAILED'): PurchaseRequest {
    if (!(e instanceof ReapApiError)) throw e;
    this.log(req.id, 'reap', type, this.errorData(e));
    if (isTransient(e)) throw e;
    return this.mutate(req.id, (d) => {
      d.status = 'FAILED';
      d.failure = { code: `REAP_${e.code}`, message: e.message };
    });
  }

  private applyCheckout(id: string, remote: Checkout): PurchaseRequest {
    const req = this.mustGet(id);
    if (req.status !== 'AWAITING_PAYMENT') return req; // someone else already applied a final state
    const previous = req.checkout?.status;

    switch (remote.status) {
      case 'COMPLETED': {
        const quoted = req.quote.total;
        const final: Money = remote.finalAmount ?? remote.amount ?? quoted;
        const policy = this.policy.get();
        const sameCurrency = final.currency === quoted.currency;
        const variance = round2(final.amount - quoted.amount);
        const threshold = Math.max(0.01, (quoted.amount * policy.reconciliationTolerancePct) / 100);
        const flagged = !sameCurrency || Math.abs(variance) - threshold > 1e-9;

        const done = this.mutate(id, (d) => {
          d.status = 'COMPLETED';
          d.checkout = { ...checkoutState(remote), finalAmount: final };
          d.reconciliation = { quotedTotal: quoted.amount, finalTotal: final.amount, variance, flagged, currency: quoted.currency };
        });
        this.log(id, 'reap', 'RECONCILED', { quoted, final, variance, flagged, orderId: remote.orderId ?? null });
        if (flagged) {
          this.log(id, 'system', 'RECONCILIATION_VARIANCE', {
            quoted,
            final,
            variance,
            tolerancePct: policy.reconciliationTolerancePct,
            ...(sameCurrency ? {} : { note: 'La moneda del cargo final difiere de la cotizada' }),
          });
        }
        return done;
      }
      case 'FAILED':
      case 'EXPIRED': {
        const failed = remote.status === 'FAILED';
        const updated = this.mutate(id, (d) => {
          d.status = failed ? 'FAILED' : 'EXPIRED';
          d.checkout = checkoutState(remote);
          d.failure = failed
            ? { code: 'REAP_CHECKOUT_FAILED', message: 'Reap reportó que el pago no se completó' }
            : { code: 'REAP_CHECKOUT_EXPIRED', message: 'La ventana de pago expiró sin que nadie aprobara el cargo' };
        });
        this.log(id, 'reap', 'CHECKOUT_STATUS', { from: previous, to: remote.status });
        return updated;
      }
      default: {
        const stale = (CHECKOUT_RANK[remote.status] ?? 0) < (CHECKOUT_RANK[previous ?? 'REQUIRES_ACTION'] ?? 0);
        if (stale || remote.status === previous) return req;
        const updated = this.mutate(id, (d) => {
          d.checkout = { ...checkoutState(remote), ...(d.checkout?.finalAmount ? { finalAmount: d.checkout.finalAmount } : {}) };
        });
        this.log(id, 'reap', 'CHECKOUT_STATUS', { from: previous, to: remote.status });
        return updated;
      }
    }
  }
}

export type { PolicyDecision };
