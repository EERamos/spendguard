import { round2 } from '../src/money';
import { PolicyProvider, PolicySchema } from '../src/domain/policy';
import type { Policy } from '../src/domain/policy';
import type { PurchaseRequest, Requester } from '../src/domain/types';
import { MOCK_CATALOG, MockReapClient } from '../src/reap/mock';
import type { ShippingAddress } from '../src/reap/types';
import { PurchaseService } from '../src/services/purchase-service';
import type { ProposeInput } from '../src/services/purchase-service';
import { JsonStore } from '../src/store/store';

export const testPolicyInput = {
  version: 1,
  baseCurrency: 'USD',
  fx: { MXN: 0.055 },
  overBudgetAction: 'DENY',
  allowSelfApproval: false,
  requireJustificationAbove: 50,
  priceTolerancePct: 10,
  reconciliationTolerancePct: 1,
  maxQuantityPerLine: 20,
  merchants: { allow: [], block: ['liquiddeath.com', 'giftcards-demo.com'] },
  blockedKeywords: ['gift card', 'tarjeta de regalo'],
  departments: {
    eng: { name: 'Ingeniería', monthlyBudget: 5000, autoApproveUnder: 150, hardCapPerPurchase: 2000, approvers: ['cto@acme.test'] },
    ops: { name: 'Operaciones', monthlyBudget: 400, autoApproveUnder: 400, hardCapPerPurchase: 500, approvers: ['coo@acme.test'] },
  },
} as const;

/** Fresh, fully-defaulted copy so tests can mutate it freely. */
export const testPolicy = (overrides: Partial<Policy> = {}): Policy =>
  ({ ...PolicySchema.parse(structuredClone(testPolicyInput)), ...overrides }) as Policy;

export const US_ADDRESS: ShippingAddress = {
  firstName: 'Demo',
  lastName: 'Builder',
  phone: '+14155550100',
  addressLine1: '1 Market Street',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94105',
  country: 'US',
};

export const ALICE: Requester = { id: 'u_alice', email: 'alice@acme.test' };
export const CTO = 'cto@acme.test';
export const COO = 'coo@acme.test';

export const START = Date.parse('2026-10-09T12:00:00.000Z');

export interface TestClock {
  now: () => number;
  advance: (ms: number) => void;
}

export function makeClock(start = START): TestClock {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

export function makeCtx(policy: Policy = testPolicy()) {
  const clock = makeClock();
  const mock = new MockReapClient({ now: clock.now, publicBaseUrl: 'http://localhost:3000' });
  const store = new JsonStore(null);
  const provider = new PolicyProvider(null, policy);
  const service = new PurchaseService({
    store,
    reap: mock,
    policy: provider,
    publicBaseUrl: 'http://localhost:3000',
    defaultShipping: US_ADDRESS,
    now: clock.now,
  });
  return { service, mock, store, policy: provider, clock };
}

export type Ctx = ReturnType<typeof makeCtx>;

/** Simulates the card holder paying on the Reap page, then polls until the order exists. */
export async function pay(ctx: Ctx, request: PurchaseRequest, opts: { finalAmount?: number } = {}): Promise<PurchaseRequest> {
  if (!request.checkout) throw new Error(`Request ${request.id} has no checkout (status ${request.status})`);
  ctx.mock.approveCheckout(request.checkout.id, opts);
  await ctx.service.refresh(request.id); // PROCESSING
  return ctx.service.refresh(request.id); // COMPLETED
}

export const SHIP_STANDARD = 9.99;
export const SHIP_EXPRESS = 24.99;

/** Same formula as MockReapClient.render(). */
export function expectedTotal(
  productId: string,
  quantity: number,
  opts: { shipping?: number; offerCode?: string; multiplier?: number } = {},
): number {
  const product = MOCK_CATALOG.find((p) => p.id === productId);
  if (!product) throw new Error(`unknown product ${productId}`);
  const unit = round2(product.variants[0]!.price * (opts.multiplier ?? 1));
  const subtotal = round2(unit * quantity);
  const discount = opts.offerCode?.toUpperCase() === 'SAVE10' ? round2(subtotal * 0.1) : 0;
  const taxable = subtotal - discount;
  const tax = round2(taxable * 0.085);
  const shipping = product.requiresShipping ? (opts.shipping ?? SHIP_STANDARD) : 0;
  return round2(taxable + shipping + tax);
}

export function proposal(overrides: Partial<ProposeInput> & Pick<ProposeInput, 'productId' | 'departmentId'>): ProposeInput {
  return {
    requester: ALICE,
    justification: 'Equipo necesario para el sprint de pagos del Q4',
    quantity: 1,
    ...overrides,
  };
}
