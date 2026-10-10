import { round2 } from '../money';
import { toBase } from './policy-engine';
import type { SpendSnapshot } from './policy-engine';
import type { Policy } from './policy';
import type { PurchaseRequest } from './types';

export const monthKey = (iso: string): string => iso.slice(0, 7);

/**
 * Derives a department's spend for a month straight from the request log (no separate balance to drift):
 *  - committed: money actually charged (COMPLETED, using the final charged amount)
 *  - reserved:  money that is promised but not yet charged (PENDING_APPROVAL and AWAITING_PAYMENT, at quote total)
 * Denied, rejected, failed, expired and cancelled requests count for nothing, so budget is released automatically.
 */
export function spendFor(
  requests: PurchaseRequest[],
  departmentId: string,
  month: string,
  policy: Policy,
  excludeId?: string,
): SpendSnapshot {
  let committed = 0;
  let reserved = 0;
  for (const r of requests) {
    if (r.departmentId !== departmentId || r.id === excludeId || monthKey(r.createdAt) !== month) continue;
    if (r.status === 'COMPLETED') {
      committed += toBase(r.checkout?.finalAmount ?? r.quote.total, policy) ?? 0;
    } else if (r.status === 'PENDING_APPROVAL' || r.status === 'AWAITING_PAYMENT') {
      reserved += toBase(r.quote.total, policy) ?? 0;
    }
  }
  return { committed: round2(committed), reserved: round2(reserved) };
}
