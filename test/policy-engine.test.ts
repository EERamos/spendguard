import { describe, expect, it } from 'vitest';
import { spendFor } from '../src/domain/ledger';
import { blockedKeyword, evaluate, merchantVerdict, toBase } from '../src/domain/policy-engine';
import type { EvaluationInput, SpendSnapshot } from '../src/domain/policy-engine';
import type { PolicyDecision, PurchaseRequest, RequestStatus } from '../src/domain/types';
import { testPolicy } from './helpers';

const NO_SPEND: SpendSnapshot = { committed: 0, reserved: 0 };

const input = (o: Partial<EvaluationInput> = {}): EvaluationInput => ({
  departmentId: 'eng',
  requesterEmail: 'alice@acme.test',
  justification: 'Teclado para el nuevo integrante del equipo',
  merchant: 'divinikey.com',
  productName: 'HMX Snowflake Linear Switches',
  quantity: 1,
  total: { amount: 100, currency: 'USD' },
  ...o,
});

const rules = (d: { hits: { rule: string }[] }) => d.hits.map((h) => h.rule);
const hit = (d: PolicyDecision, rule: string) => d.hits.find((h) => h.rule === rule);

describe('evaluate()', () => {
  const policy = testPolicy();

  it('auto-approves a clean purchase under the limit (WITHIN_AUTO_APPROVE_LIMIT)', () => {
    const d = evaluate(input(), policy, NO_SPEND);
    expect(d.outcome).toBe('AUTO_APPROVE');
    expect(rules(d)).toEqual(['WITHIN_AUTO_APPROVE_LIMIT']);
    expect(d.policyVersion).toBe(1);
    expect(d.budget).toEqual({
      departmentId: 'eng',
      currency: 'USD',
      monthlyBudget: 5000,
      committed: 0,
      reserved: 0,
      requested: 100,
      remainingBefore: 5000,
      remainingAfter: 4900,
    });
  });

  it('treats a total exactly at autoApproveUnder as auto-approvable', () => {
    const d = evaluate(input({ total: { amount: 150, currency: 'USD' } }), policy, NO_SPEND);
    expect(d.outcome).toBe('AUTO_APPROVE');
  });

  it('requires approval above the auto-approve limit (APPROVAL_THRESHOLD)', () => {
    const d = evaluate(input({ total: { amount: 150.01, currency: 'USD' } }), policy, NO_SPEND);
    expect(d.outcome).toBe('REQUIRE_APPROVAL');
    expect(rules(d)).toEqual(['APPROVAL_THRESHOLD']);
  });

  it('denies an unknown department and stops there', () => {
    const d = evaluate(input({ departmentId: 'legal', merchant: 'liquiddeath.com' }), policy, NO_SPEND);
    expect(d.outcome).toBe('DENY');
    expect(rules(d)).toEqual(['UNKNOWN_DEPARTMENT']);
    expect(d.budget).toBeNull();
  });

  describe('merchants', () => {
    it('denies a blocked merchant (MERCHANT_BLOCKED)', () => {
      const d = evaluate(input({ merchant: 'liquiddeath.com' }), policy, NO_SPEND);
      expect(d.outcome).toBe('DENY');
      expect(hit(d, 'MERCHANT_BLOCKED')?.outcome).toBe('DENY');
    });

    it('matches subdomains and is case-insensitive, but not lookalike suffixes', () => {
      expect(merchantVerdict('shop.liquiddeath.com', policy)).toBe('BLOCKED');
      expect(merchantVerdict('LiquidDeath.COM', policy)).toBe('BLOCKED');
      expect(merchantVerdict('notliquiddeath.com', policy)).toBe('ALLOWED');
      const d = evaluate(input({ merchant: 'eu.store.liquiddeath.com' }), policy, NO_SPEND);
      expect(rules(d)).toContain('MERCHANT_BLOCKED');
    });

    it('denies merchants outside a non-empty allowlist (MERCHANT_NOT_ALLOWLISTED)', () => {
      const p = testPolicy({ merchants: { allow: ['divinikey.com', 'baseus.com'], block: ['liquiddeath.com'] } });
      expect(merchantVerdict('divinikey.com', p)).toBe('ALLOWED');
      expect(merchantVerdict('us.baseus.com', p)).toBe('ALLOWED');
      const d = evaluate(input({ merchant: 'arzopa.com' }), p, NO_SPEND);
      expect(d.outcome).toBe('DENY');
      expect(hit(d, 'MERCHANT_NOT_ALLOWLISTED')?.outcome).toBe('DENY');
    });

    it('block wins over allow', () => {
      const p = testPolicy({ merchants: { allow: ['liquiddeath.com'], block: ['liquiddeath.com'] } });
      expect(merchantVerdict('liquiddeath.com', p)).toBe('BLOCKED');
    });
  });

  describe('keywords', () => {
    it('denies when the product name contains a blocked keyword (KEYWORD_BLOCKED)', () => {
      const d = evaluate(input({ productName: 'Amazon GIFT CARD $50' }), policy, NO_SPEND);
      expect(d.outcome).toBe('DENY');
      expect(hit(d, 'KEYWORD_BLOCKED')?.message).toContain('gift card');
    });

    it('also checks the requester search text', () => {
      const d = evaluate(input({ searchText: 'quiero una tarjeta de regalo' }), policy, NO_SPEND);
      expect(rules(d)).toContain('KEYWORD_BLOCKED');
      expect(blockedKeyword('Tarjeta de Regalo Liverpool', policy)).toBe('tarjeta de regalo');
      expect(blockedKeyword('cargador usb-c', policy)).toBeUndefined();
    });
  });

  it('denies quantities above maxQuantityPerLine (QUANTITY_LIMIT)', () => {
    expect(rules(evaluate(input({ quantity: 20 }), policy, NO_SPEND))).not.toContain('QUANTITY_LIMIT');
    const d = evaluate(input({ quantity: 21 }), policy, NO_SPEND);
    expect(d.outcome).toBe('DENY');
    expect(rules(d)).toContain('QUANTITY_LIMIT');
  });

  it('denies totals above the per-purchase hard cap (HARD_CAP)', () => {
    expect(rules(evaluate(input({ total: { amount: 2000, currency: 'USD' } }), policy, NO_SPEND))).not.toContain('HARD_CAP');
    const d = evaluate(input({ total: { amount: 2000.01, currency: 'USD' } }), policy, NO_SPEND);
    expect(d.outcome).toBe('DENY');
    expect(hit(d, 'HARD_CAP')?.outcome).toBe('DENY');
  });

  describe('BUDGET_EXCEEDED', () => {
    const ops = (amount: number) => input({ departmentId: 'ops', total: { amount, currency: 'USD' } });

    it('counts committed and reserved spend and denies in DENY mode', () => {
      const spend = { committed: 200, reserved: 150 };
      const ok = evaluate(ops(50), policy, spend);
      expect(ok.outcome).toBe('AUTO_APPROVE');
      expect(ok.budget).toMatchObject({ remainingBefore: 50, remainingAfter: 0 });

      const d = evaluate(ops(50.01), policy, spend);
      expect(d.outcome).toBe('DENY');
      expect(hit(d, 'BUDGET_EXCEEDED')?.outcome).toBe('DENY');
      expect(d.budget).toMatchObject({ committed: 200, reserved: 150, requested: 50.01, remainingBefore: 50, remainingAfter: -0.01 });
    });

    it('routes to a human in REQUIRE_APPROVAL mode', () => {
      const p = testPolicy({ overBudgetAction: 'REQUIRE_APPROVAL' });
      const d = evaluate(ops(100), p, { committed: 350, reserved: 0 });
      expect(d.outcome).toBe('REQUIRE_APPROVAL');
      expect(hit(d, 'BUDGET_EXCEEDED')?.outcome).toBe('REQUIRE_APPROVAL');
      // Still under ops' auto-approve limit: only the budget rule escalates it.
      expect(rules(d)).toContain('WITHIN_AUTO_APPROVE_LIMIT');
    });
  });

  it('requires a real justification above requireJustificationAbove (JUSTIFICATION_REQUIRED)', () => {
    expect(rules(evaluate(input({ justification: 'x', total: { amount: 50, currency: 'USD' } }), policy, NO_SPEND))).not.toContain(
      'JUSTIFICATION_REQUIRED',
    );
    const d = evaluate(input({ justification: '  corto   ', total: { amount: 50.01, currency: 'USD' } }), policy, NO_SPEND);
    expect(d.outcome).toBe('DENY');
    expect(rules(d)).toContain('JUSTIFICATION_REQUIRED');
    const ok = evaluate(input({ justification: '0123456789', total: { amount: 80, currency: 'USD' } }), policy, NO_SPEND);
    expect(rules(ok)).not.toContain('JUSTIFICATION_REQUIRED');
  });

  it('converts MXN to the base currency for limits and budget', () => {
    expect(toBase({ amount: 2000, currency: 'MXN' }, policy)).toBe(110);
    const d = evaluate(input({ total: { amount: 2000, currency: 'MXN' } }), policy, NO_SPEND); // 110 USD
    expect(d.outcome).toBe('AUTO_APPROVE');
    expect(d.budget?.requested).toBe(110);
    expect(d.budget?.currency).toBe('USD');

    const big = evaluate(input({ total: { amount: 3000, currency: 'MXN' } }), policy, NO_SPEND); // 165 USD
    expect(big.outcome).toBe('REQUIRE_APPROVAL');
    expect(rules(big)).toContain('APPROVAL_THRESHOLD');
  });

  it('fails closed on currencies without an FX rate (CURRENCY_UNSUPPORTED)', () => {
    expect(toBase({ amount: 10, currency: 'EUR' }, policy)).toBeNull();
    const d = evaluate(input({ total: { amount: 10, currency: 'EUR' } }), policy, NO_SPEND);
    expect(d.outcome).toBe('DENY');
    expect(rules(d)).toEqual(['CURRENCY_UNSUPPORTED']);
    expect(d.budget).toBeNull();
  });

  it('flags a quote above the declared max plus tolerance (PRICE_DRIFT)', () => {
    // 100 declared -> up to 110 tolerated.
    expect(rules(evaluate(input({ declaredMaxTotal: 100, total: { amount: 110, currency: 'USD' } }), policy, NO_SPEND))).not.toContain(
      'PRICE_DRIFT',
    );
    const d = evaluate(input({ declaredMaxTotal: 100, total: { amount: 110.01, currency: 'USD' } }), policy, NO_SPEND);
    expect(d.outcome).toBe('REQUIRE_APPROVAL');
    expect(hit(d, 'PRICE_DRIFT')?.outcome).toBe('REQUIRE_APPROVAL');
  });

  it('collects every hit and resolves to the strictest outcome', () => {
    const d = evaluate(
      input({
        merchant: 'giftcards-demo.com',
        productName: 'Gift card $100',
        quantity: 25,
        justification: 'no',
        total: { amount: 2500, currency: 'USD' },
        declaredMaxTotal: 100,
      }),
      policy,
      { committed: 4000, reserved: 0 },
    );
    expect(d.outcome).toBe('DENY');
    expect(rules(d)).toEqual([
      'MERCHANT_BLOCKED',
      'KEYWORD_BLOCKED',
      'QUANTITY_LIMIT',
      'HARD_CAP',
      'BUDGET_EXCEEDED',
      'JUSTIFICATION_REQUIRED',
      'PRICE_DRIFT',
      'APPROVAL_THRESHOLD',
    ]);
  });

  it('REQUIRE_APPROVAL beats AUTO_APPROVE when nothing denies', () => {
    const d = evaluate(input({ declaredMaxTotal: 10, total: { amount: 20, currency: 'USD' } }), policy, NO_SPEND);
    expect(rules(d)).toEqual(['PRICE_DRIFT', 'WITHIN_AUTO_APPROVE_LIMIT']);
    expect(d.outcome).toBe('REQUIRE_APPROVAL');
  });
});

describe('spendFor()', () => {
  const policy = testPolicy();
  let n = 0;
  const req = (
    status: RequestStatus,
    total: number,
    o: { dept?: string; createdAt?: string; finalAmount?: number; currency?: string; id?: string } = {},
  ): PurchaseRequest => {
    const currency = o.currency ?? 'USD';
    return {
      id: o.id ?? `req_${++n}`,
      createdAt: o.createdAt ?? '2026-10-05T10:00:00.000Z',
      updatedAt: o.createdAt ?? '2026-10-05T10:00:00.000Z',
      requester: { id: 'u', email: 'u@acme.test' },
      departmentId: o.dept ?? 'eng',
      justification: 'x',
      item: {
        productId: 'p',
        productName: 'p',
        merchant: 'm.com',
        variantId: 'v',
        quantity: 1,
        unitPrice: { amount: total, currency },
      },
      quote: {
        id: 'q',
        attempt: 1,
        createdAt: '2026-10-05T10:00:00.000Z',
        expiresAt: '2026-10-05T10:10:00.000Z',
        total: { amount: total, currency },
        breakdown: { itemsSubtotal: { amount: total, currency }, discounts: [], additionalCharges: [], finalAmount: { amount: total, currency } },
        shippingOptions: [],
      },
      decision: { outcome: 'AUTO_APPROVE', hits: [], budget: null, policyVersion: 1 },
      status,
      ...(o.finalAmount !== undefined ? { checkout: { id: 'chk', status: 'COMPLETED', finalAmount: { amount: o.finalAmount, currency } } } : {}),
    };
  };

  it('commits COMPLETED at the final charged amount and reserves PENDING_APPROVAL + AWAITING_PAYMENT at quote total', () => {
    const rows = [
      req('COMPLETED', 100, { finalAmount: 103.5 }),
      req('COMPLETED', 20), // no finalAmount recorded: falls back to the quote
      req('PENDING_APPROVAL', 40.1),
      req('AWAITING_PAYMENT', 9.9),
    ];
    expect(spendFor(rows, 'eng', '2026-10', policy)).toEqual({ committed: 123.5, reserved: 50 });
  });

  it('ignores released statuses, other departments and other months', () => {
    const rows = [
      req('DENIED', 1),
      req('REJECTED', 2),
      req('FAILED', 4),
      req('EXPIRED', 8),
      req('CANCELLED', 16),
      req('COMPLETED', 32, { dept: 'ops', finalAmount: 32 }),
      req('PENDING_APPROVAL', 64, { dept: 'ops' }),
      req('COMPLETED', 128, { createdAt: '2026-09-30T23:59:59.000Z', finalAmount: 128 }),
      req('AWAITING_PAYMENT', 256, { createdAt: '2026-11-01T00:00:00.000Z' }),
    ];
    expect(spendFor(rows, 'eng', '2026-10', policy)).toEqual({ committed: 0, reserved: 0 });
    expect(spendFor(rows, 'ops', '2026-10', policy)).toEqual({ committed: 32, reserved: 64 });
  });

  it('converts foreign currencies and honours excludeId', () => {
    const rows = [req('PENDING_APPROVAL', 1000, { currency: 'MXN' }), req('PENDING_APPROVAL', 10, { id: 'req_self' })];
    expect(spendFor(rows, 'eng', '2026-10', policy)).toEqual({ committed: 0, reserved: 65 });
    expect(spendFor(rows, 'eng', '2026-10', policy, 'req_self')).toEqual({ committed: 0, reserved: 55 });
  });
});
