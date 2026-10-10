import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/util/errors';
import { ALICE, COO, CTO, expectedTotal, makeCtx, pay, proposal, testPolicy } from './helpers';

const QUOTE_TTL_MS = 10 * 60_000;

async function expectDomainError(p: Promise<unknown>, code: string, status: number): Promise<DomainError> {
  const err = await p.then(
    () => {
      throw new Error(`expected DomainError ${code}, but the call succeeded`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect(err).toMatchObject({ code, status });
  return err as DomainError;
}

const budgetOf = (ctx: ReturnType<typeof makeCtx>, dept: string) => ctx.service.budgets().find((b) => b.departmentId === dept)!;

describe('expected totals (sanity check of the mock formula)', () => {
  it('matches the numbers the scenarios are built around', () => {
    expect(expectedTotal('p_switches', 2)).toBe(23.66);
    expect(expectedTotal('p_monitor', 1)).toBe(161.88);
    expect(expectedTotal('p_optiplex', 1)).toBe(769.48);
    expect(expectedTotal('p_powerbank', 3)).toBe(237.81);
  });
});

describe('PurchaseService end to end (mock Reap)', () => {
  it('auto-approves a small purchase, opens a checkout, pays and reconciles', async () => {
    const ctx = makeCtx();
    const total = expectedTotal('p_switches', 2);
    const req = await ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng', quantity: 2 }));

    expect(req.status).toBe('AWAITING_PAYMENT');
    expect(req.decision.outcome).toBe('AUTO_APPROVE');
    expect(req.quote.total).toEqual({ amount: total, currency: 'USD' });
    expect(req.item).toMatchObject({ productId: 'p_switches', merchant: 'divinikey.com', quantity: 2, unitPrice: { amount: 6.3, currency: 'USD' } });
    expect(req.checkout?.paymentUrl).toMatch(/^http:\/\/localhost:3000\/mock\/reap\/approve\/chk_/);
    expect(ctx.mock.checkoutCount).toBe(1);
    expect(budgetOf(ctx, 'eng')).toMatchObject({ committed: 0, reserved: total, remaining: 5000 - total });

    const done = await pay(ctx, req);
    expect(done.status).toBe('COMPLETED');
    expect(done.checkout?.orderId).toMatch(/^ORD-/);
    expect(done.checkout?.finalAmount).toEqual({ amount: total, currency: 'USD' });
    expect(done.reconciliation).toEqual({ quotedTotal: total, finalTotal: total, variance: 0, flagged: false, currency: 'USD' });
    expect(budgetOf(ctx, 'eng')).toMatchObject({ committed: total, reserved: 0, remaining: 5000 - total });

    // Further polls are no-ops.
    expect((await ctx.service.refresh(req.id)).status).toBe('COMPLETED');
  });

  it('records the audit trail of the auto flow in order', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng', quantity: 2 }));
    await pay(ctx, req);
    const types = ctx.service.audit(req.id).map((e) => e.type);
    expect(types).toEqual([
      'REQUEST_CREATED',
      'QUOTE_CREATED',
      'POLICY_EVALUATED',
      'AUTO_APPROVED',
      'CHECKOUT_CREATED',
      'CHECKOUT_STATUS', // REQUIRES_ACTION -> PROCESSING
      'RECONCILED',
    ]);
    expect(ctx.service.audit(req.id).every((e) => e.requestId === req.id)).toBe(true);
  });

  it('holds a purchase above the auto-approve limit until an approver accepts it', async () => {
    const ctx = makeCtx();
    const total = expectedTotal('p_monitor', 1);
    const req = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng' }));

    expect(req.status).toBe('PENDING_APPROVAL');
    expect(req.decision.outcome).toBe('REQUIRE_APPROVAL');
    expect(req.quote.total.amount).toBe(total);
    expect(req.checkout).toBeUndefined();
    expect(ctx.mock.checkoutCount).toBe(0);
    expect(budgetOf(ctx, 'eng').reserved).toBe(total);
    expect(ctx.service.audit(req.id).map((e) => e.type)).toContain('APPROVAL_REQUESTED');

    const approved = await ctx.service.approve(req.id, CTO, 'ok');
    expect(approved.status).toBe('AWAITING_PAYMENT');
    expect(approved.approval).toMatchObject({ by: CTO, note: 'ok', approvedTotal: { amount: total, currency: 'USD' } });
    expect(approved.checkout?.paymentUrl).toBeTruthy();
    expect(ctx.mock.checkoutCount).toBe(1);

    const done = await pay(ctx, approved);
    expect(done.status).toBe('COMPLETED');
    expect(budgetOf(ctx, 'eng')).toMatchObject({ committed: total, reserved: 0 });
  });

  it('denies a purchase above the hard cap', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_optiplex', departmentId: 'ops' }));
    expect(req.quote.total.amount).toBe(expectedTotal('p_optiplex', 1));
    expect(req.status).toBe('DENIED');
    expect(req.decision.hits.map((h) => h.rule)).toContain('HARD_CAP');
    expect(req.checkout).toBeUndefined();
    expect(ctx.mock.checkoutCount).toBe(0);
    expect(budgetOf(ctx, 'ops').reserved).toBe(0);
  });

  it('denies a blocked merchant', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_planter', departmentId: 'eng' }));
    expect(req.status).toBe('DENIED');
    expect(req.decision.hits.map((h) => h.rule)).toContain('MERCHANT_BLOCKED');
    expect(ctx.mock.checkoutCount).toBe(0);
  });

  it('denies a purchase above 50 USD with a token justification', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_powerbank', departmentId: 'eng', justification: 'porque' }));
    expect(req.status).toBe('DENIED');
    expect(req.decision.hits.map((h) => h.rule)).toEqual(['JUSTIFICATION_REQUIRED', 'WITHIN_AUTO_APPROVE_LIMIT']);
  });

  it('never lets two parallel proposals overspend the same budget', async () => {
    const ctx = makeCtx();
    const total = expectedTotal('p_powerbank', 3);
    const [a, b] = await Promise.all([
      ctx.service.propose(proposal({ productId: 'p_powerbank', departmentId: 'ops', quantity: 3 })),
      ctx.service.propose(proposal({ productId: 'p_powerbank', departmentId: 'ops', quantity: 3, requester: { id: 'u_bob', email: 'bob@acme.test' } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['AWAITING_PAYMENT', 'DENIED']);
    const denied = a.status === 'DENIED' ? a : b;
    expect(denied.decision.hits.find((h) => h.rule === 'BUDGET_EXCEEDED')?.outcome).toBe('DENY');
    expect(denied.decision.budget).toMatchObject({ reserved: total, remainingBefore: Math.round((400 - total) * 100) / 100 });
    expect(ctx.mock.checkoutCount).toBe(1);
    expect(budgetOf(ctx, 'ops')).toMatchObject({ reserved: total, committed: 0 });
  });

  it('forbids approving your own request', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng', requester: { id: 'u_cto', email: CTO } }));
    await expectDomainError(ctx.service.approve(req.id, 'CTO@acme.test'), 'SELF_APPROVAL_FORBIDDEN', 403);
    expect(ctx.service.get(req.id).status).toBe('PENDING_APPROVAL');
    expect(ctx.mock.checkoutCount).toBe(0);
  });

  it('only lets the department approvers approve', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng' }));
    await expectDomainError(ctx.service.approve(req.id, COO), 'NOT_AN_APPROVER', 403);
    await expectDomainError(ctx.service.reject(req.id, 'mallory@acme.test', 'no'), 'NOT_AN_APPROVER', 403);
    await expectDomainError(ctx.service.approve(req.id, '  '), 'ACTOR_REQUIRED', 400);
    expect(ctx.service.get(req.id).status).toBe('PENDING_APPROVAL');
  });

  it('re-quotes an expired quote on approval and opens the checkout on the new quote', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng', shippingOptionId: 'ship_express' }));
    expect(req.quote.total.amount).toBe(expectedTotal('p_monitor', 1, { shipping: 24.99 }));

    ctx.clock.advance(QUOTE_TTL_MS + 1_000);
    const approved = await ctx.service.approve(req.id, CTO);

    expect(approved.status).toBe('AWAITING_PAYMENT');
    expect(approved.quote.attempt).toBe(2);
    expect(approved.quote.id).not.toBe(req.quote.id);
    // The shipping method chosen at proposal time survives the re-quote.
    expect(approved.quote.shippingOptions.find((o) => o.selected)?.id).toBe('ship_express');
    expect(approved.quote.total).toEqual(req.quote.total);
    expect(ctx.mock.checkoutCount).toBe(1);
    expect(ctx.service.audit(req.id).map((e) => e.type)).toContain('QUOTE_REFRESHED');
  });

  it('also re-quotes when the quote is about to expire (inside the safety margin)', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng' }));
    ctx.clock.advance(QUOTE_TTL_MS - 5_000);
    const approved = await ctx.service.approve(req.id, CTO);
    expect(approved.status).toBe('AWAITING_PAYMENT');
    expect(approved.quote.attempt).toBe(2);
  });

  it('stops the approval with PRICE_CHANGED when the re-quote rose beyond tolerance', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng' }));
    ctx.mock.priceMultiplier = 1.3;
    ctx.clock.advance(QUOTE_TTL_MS + 1_000);

    const err = await expectDomainError(ctx.service.approve(req.id, CTO), 'PRICE_CHANGED', 409);
    const newTotal = expectedTotal('p_monitor', 1, { multiplier: 1.3 });
    expect(err.detail).toMatchObject({ approvedTotal: req.quote.total, newTotal: { amount: newTotal, currency: 'USD' } });

    const after = ctx.service.get(req.id);
    expect(after.status).toBe('PENDING_APPROVAL');
    expect(after.quote.attempt).toBe(2);
    expect(after.quote.total.amount).toBe(newTotal);
    expect(after.checkout).toBeUndefined();
    expect(ctx.mock.checkoutCount).toBe(0);
    // The reservation follows the new price.
    expect(budgetOf(ctx, 'eng').reserved).toBe(newTotal);

    // The approver saw the new price; approving again goes through on the fresh quote.
    const approved = await ctx.service.approve(req.id, CTO);
    expect(approved.status).toBe('AWAITING_PAYMENT');
    expect(approved.approval?.approvedTotal.amount).toBe(newTotal);
    expect(ctx.mock.checkoutCount).toBe(1);
  });

  it('accepts a re-quote that rose within tolerance', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng' }));
    ctx.mock.priceMultiplier = 1.05;
    ctx.clock.advance(QUOTE_TTL_MS + 1_000);
    const approved = await ctx.service.approve(req.id, CTO);
    expect(approved.status).toBe('AWAITING_PAYMENT');
    expect(approved.quote.total.amount).toBe(expectedTotal('p_monitor', 1, { multiplier: 1.05 }));
    expect(approved.approval?.approvedTotal).toEqual(req.quote.total);
  });

  it('denies on approval when the budget was used up while waiting', async () => {
    const ctx = makeCtx();
    // ops: autoApproveUnder 400, so ask for something that needs approval via declaredMaxTotal drift.
    const pending = await ctx.service.propose(proposal({ productId: 'p_powerbank', departmentId: 'ops', quantity: 3, declaredMaxTotal: 100 }));
    expect(pending.status).toBe('PENDING_APPROVAL');
    // Shrink the budget under it.
    const p = ctx.service.getPolicy();
    ctx.service.updatePolicy({ ...p, departments: { ...p.departments, ops: { ...p.departments.ops!, monthlyBudget: 100 } } }, 'admin@acme.test');
    const res = await ctx.service.approve(pending.id, COO);
    expect(res.status).toBe('DENIED');
    expect(res.decision.policyVersion).toBe(2);
    expect(res.decision.hits.map((h) => h.rule)).toContain('BUDGET_EXCEEDED');
    expect(ctx.mock.checkoutCount).toBe(0);
  });

  it('serializes a concurrent double approval: one checkout, one INVALID_STATE', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng' }));
    const results = await Promise.allSettled([ctx.service.approve(req.id, CTO), ctx.service.approve(req.id, CTO)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ code: 'INVALID_STATE', status: 409 });
    expect(ctx.mock.checkoutCount).toBe(1);
  });

  it('flags a final charge outside the reconciliation tolerance', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng', quantity: 2 }));
    const quoted = req.quote.total.amount;
    const final = Math.round(quoted * 1.05 * 100) / 100;
    const done = await pay(ctx, req, { finalAmount: final });

    expect(done.status).toBe('COMPLETED');
    expect(done.reconciliation).toMatchObject({ quotedTotal: quoted, finalTotal: final, flagged: true });
    expect(done.reconciliation!.variance).toBeCloseTo(final - quoted, 2);
    const types = ctx.service.audit(req.id).map((e) => e.type);
    expect(types.slice(-2)).toEqual(['RECONCILED', 'RECONCILIATION_VARIANCE']);
    // The budget is charged what Reap actually charged.
    expect(budgetOf(ctx, 'eng').committed).toBe(final);
  });

  it('does not flag a final charge within tolerance', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_powerbank', departmentId: 'eng' }));
    const quoted = req.quote.total.amount;
    const done = await pay(ctx, req, { finalAmount: Math.round(quoted * 1.005 * 100) / 100 });
    expect(done.reconciliation?.flagged).toBe(false);
    expect(ctx.service.audit(req.id).map((e) => e.type)).not.toContain('RECONCILIATION_VARIANCE');
  });

  it('releases the reservation on reject and on cancel', async () => {
    const ctx = makeCtx();
    const a = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng' }));
    const b = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng' }));
    expect(budgetOf(ctx, 'eng').reserved).toBe(2 * expectedTotal('p_monitor', 1));

    const rejected = await ctx.service.reject(a.id, CTO, 'No hay necesidad');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejection).toMatchObject({ by: CTO, reason: 'No hay necesidad' });
    expect(budgetOf(ctx, 'eng').reserved).toBe(expectedTotal('p_monitor', 1));

    // Someone else cannot cancel, the requester can.
    await expectDomainError(ctx.service.cancel(b.id, 'bob@acme.test'), 'NOT_AN_APPROVER', 403);
    const cancelled = await ctx.service.cancel(b.id, ALICE.email.toUpperCase());
    expect(cancelled.status).toBe('CANCELLED');
    expect(budgetOf(ctx, 'eng')).toMatchObject({ reserved: 0, committed: 0, remaining: 5000 });

    await expectDomainError(ctx.service.approve(a.id, CTO), 'INVALID_STATE', 409);
    await expectDomainError(ctx.service.cancel(b.id, ALICE.email), 'INVALID_STATE', 409);
  });

  it('dedupes proposals by clientRef', async () => {
    const ctx = makeCtx();
    const first = await ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng', clientRef: 'agent-run-1' }));
    const again = await ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng', clientRef: 'agent-run-1' }));
    expect(again.id).toBe(first.id);
    expect(ctx.service.list()).toHaveLength(1);
    expect(ctx.mock.checkoutCount).toBe(1);

    // Also when the retries race each other.
    const [x, y] = await Promise.all([
      ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng', clientRef: 'agent-run-2' })),
      ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng', clientRef: 'agent-run-2' })),
    ]);
    expect(x.id).toBe(y.id);
    expect(ctx.service.list()).toHaveLength(2);
    expect(ctx.mock.checkoutCount).toBe(2);
  });

  it('scopes clientRef dedupe to the requester (no leaking another requester payment link)', async () => {
    const ctx = makeCtx();
    const mine = await ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng', clientRef: 'shared-ref' }));
    const sameMe = await ctx.service.propose(
      proposal({ productId: 'p_switches', departmentId: 'eng', clientRef: 'shared-ref', requester: { id: ALICE.id, email: ' Alice@ACME.test ' } }),
    );
    expect(sameMe.id).toBe(mine.id);

    const theirs = await ctx.service.propose(
      proposal({ productId: 'p_switches', departmentId: 'eng', clientRef: 'shared-ref', requester: { id: 'u_bob', email: 'bob@acme.test' } }),
    );
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.requester.email).toBe('bob@acme.test');
    expect(theirs.checkout?.paymentUrl).not.toBe(mine.checkout?.paymentUrl);
  });

  it('resolves the variant from optionIds', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_coffee', departmentId: 'eng', optionIds: ['opt_coffee_beans'] }));
    expect(req.item.variantId).toBe('var_p_coffee_beans');
    expect(req.item.productName).toBe("Jacked O' Lantern 12oz (Whole Bean)");
    expect(req.status).toBe('AWAITING_PAYMENT');

    const dflt = await ctx.service.propose(proposal({ productId: 'p_coffee', departmentId: 'eng' }));
    expect(dflt.item.variantId).toBe('var_p_coffee_ground');
  });

  it('applies an offer code to the judged total', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_monitor', departmentId: 'eng', offerCode: 'SAVE10' }));
    const total = expectedTotal('p_monitor', 1, { offerCode: 'SAVE10' });
    expect(req.quote.total.amount).toBe(total);
    expect(total).toBeLessThan(150);
    expect(req.status).toBe('AWAITING_PAYMENT');
  });

  it('validates input before talking to Reap', async () => {
    const ctx = makeCtx();
    await expectDomainError(ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'legal' })), 'UNKNOWN_DEPARTMENT', 400);
    await expectDomainError(ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng', quantity: 0 })), 'INVALID_QUANTITY', 400);
    await expectDomainError(ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng', quantity: 1.5 })), 'INVALID_QUANTITY', 400);
    await expectDomainError(ctx.service.propose(proposal({ productId: 'p_nope', departmentId: 'eng' })), 'PRODUCT_NOT_FOUND', 404);
    await expectDomainError(ctx.service.approve('req_missing', CTO), 'REQUEST_NOT_FOUND', 404);
    expect(ctx.service.list()).toHaveLength(0);
  });

  it('search moves policy-denied results to filteredOut', async () => {
    const ctx = makeCtx();
    const planter = await ctx.service.searchProducts('planter maceta');
    expect(planter.products.map((p) => p.productId)).not.toContain('p_planter');
    expect(planter.filteredOut).toContainEqual(expect.objectContaining({ productId: 'p_planter', rule: 'MERCHANT_BLOCKED' }));

    const gift = await ctx.service.searchProducts('tarjeta de regalo');
    expect(gift.products).toHaveLength(0);
    expect(gift.filteredOut.map((p) => p.productId)).toContain('p_giftcard');

    // The search text itself is checked against blocked keywords.
    const sneaky = await ctx.service.searchProducts('power bank gift card');
    expect(sneaky.products).toHaveLength(0);
    expect(sneaky.filteredOut).toContainEqual(expect.objectContaining({ productId: 'p_powerbank', rule: 'KEYWORD_BLOCKED' }));

    const clean = await ctx.service.searchProducts('power bank');
    expect(clean.filteredOut).toHaveLength(0);
    expect(clean.products[0]).toMatchObject({ productId: 'p_powerbank', merchant: 'baseus.com', available: true });

    await expectDomainError(ctx.service.searchProducts('   '), 'EMPTY_QUERY', 400);
  });

  it('honours the allowlist in search', async () => {
    const ctx = makeCtx(testPolicy({ merchants: { allow: ['baseus.com'], block: [] } }));
    const res = await ctx.service.searchProducts('monitor portable');
    expect(res.products).toHaveLength(0);
    expect(res.filteredOut).toContainEqual(expect.objectContaining({ productId: 'p_monitor', rule: 'MERCHANT_NOT_ALLOWLISTED' }));
  });

  it('reconcileOpen polls every open checkout and moves them forward', async () => {
    const ctx = makeCtx();
    const a = await ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng' }));
    const b = await ctx.service.propose(proposal({ productId: 'p_towels', departmentId: 'eng' }));
    ctx.mock.approveCheckout(a.checkout!.id);
    ctx.mock.failCheckout(b.checkout!.id);

    const first = await ctx.service.reconcileOpen();
    expect(first).toEqual({ checked: 2, changed: 2, errors: [] });
    expect(ctx.service.get(a.id).checkout?.status).toBe('PROCESSING');
    expect(ctx.service.get(b.id)).toMatchObject({ status: 'FAILED', failure: { code: 'REAP_CHECKOUT_FAILED' } });

    const second = await ctx.service.reconcileOpen();
    expect(second).toEqual({ checked: 1, changed: 1, errors: [] });
    expect(ctx.service.get(a.id).status).toBe('COMPLETED');
    expect(budgetOf(ctx, 'eng').reserved).toBe(0);
  });

  it('expires a checkout nobody paid', async () => {
    const ctx = makeCtx();
    const req = await ctx.service.propose(proposal({ productId: 'p_switches', departmentId: 'eng' }));
    ctx.clock.advance(31 * 60_000);
    const after = await ctx.service.refresh(req.id);
    expect(after).toMatchObject({ status: 'EXPIRED', failure: { code: 'REAP_CHECKOUT_EXPIRED' } });
    expect(budgetOf(ctx, 'eng').reserved).toBe(0);
  });
});
