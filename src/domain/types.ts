import type { Money } from '../money';
import type { AmountBreakdown, ShippingAddress, ShippingOption } from '../reap/types';

export type PolicyOutcome = 'AUTO_APPROVE' | 'REQUIRE_APPROVAL' | 'DENY';

export interface RuleHit {
  /** Stable rule code, e.g. HARD_CAP */
  rule: string;
  outcome: PolicyOutcome;
  /** Human-readable explanation (Spanish), safe to show to the agent and the approver. */
  message: string;
}

export interface BudgetSnapshot {
  departmentId: string;
  currency: string;
  monthlyBudget: number;
  committed: number;
  reserved: number;
  requested: number;
  remainingBefore: number;
  remainingAfter: number;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  hits: RuleHit[];
  budget: BudgetSnapshot | null;
  policyVersion: number;
}

/**
 * QUOTED is never persisted; the lifecycle is:
 *   DENIED                         policy said no (terminal)
 *   PENDING_APPROVAL -> REJECTED   an internal approver said no (terminal)
 *   PENDING_APPROVAL | (auto) -> AWAITING_PAYMENT   Reap checkout is open, waiting for the card holder
 *   AWAITING_PAYMENT -> COMPLETED | FAILED | EXPIRED
 *   PENDING_APPROVAL -> CANCELLED
 */
export type RequestStatus =
  | 'DENIED'
  | 'PENDING_APPROVAL'
  | 'REJECTED'
  | 'AWAITING_PAYMENT'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface Requester {
  id: string;
  email: string;
}

export interface QuoteSnapshot {
  id: string;
  /** 1 for the first quote, +1 each time it is refreshed because it expired. */
  attempt: number;
  createdAt: string;
  expiresAt: string;
  total: Money;
  breakdown: AmountBreakdown;
  shippingOptions: ShippingOption[];
}

export interface PurchaseRequest {
  id: string;
  createdAt: string;
  updatedAt: string;
  requester: Requester;
  departmentId: string;
  justification: string;
  searchText?: string;
  declaredMaxTotal?: number;
  offerCode?: string;
  /** Caller-supplied dedupe key: proposing twice with the same clientRef returns the first request (safe agent retries). */
  clientRef?: string;
  shippingAddress?: ShippingAddress;
  item: {
    productId: string;
    productName: string;
    merchant: string;
    variantId: string;
    quantity: number;
    unitPrice: Money;
  };
  quote: QuoteSnapshot;
  decision: PolicyDecision;
  status: RequestStatus;
  approval?: { by: string; at: string; note?: string; approvedTotal: Money };
  rejection?: { by: string; at: string; reason: string };
  failure?: { code: string; message: string };
  checkout?: {
    id: string;
    status: string;
    /** Reap-hosted page where the card holder reviews and pays. */
    paymentUrl?: string;
    paymentUrlExpiresAt?: string;
    orderId?: string | null;
    finalAmount?: Money;
  };
  reconciliation?: { quotedTotal: number; finalTotal: number; variance: number; flagged: boolean; currency: string };
}

export interface AuditEvent {
  id: string;
  at: string;
  requestId: string | null;
  actor: string;
  type: string;
  data?: unknown;
}
