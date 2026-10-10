import { fmt, round2 } from '../money';
import type { Money } from '../money';
import type { Policy } from './policy';
import type { BudgetSnapshot, PolicyDecision, PolicyOutcome, RuleHit } from './types';

export interface EvaluationInput {
  departmentId: string;
  requesterEmail: string;
  justification: string;
  merchant: string;
  productName: string;
  /** Free text the requester searched for; also checked against blocked keywords. */
  searchText?: string;
  quantity: number;
  /** Final quoted total, as the merchant priced it. */
  total: Money;
  /** What the requester said they were willing to pay, in the quote's currency. */
  declaredMaxTotal?: number;
}

/** Spend already counted against the department this month, in base currency. */
export interface SpendSnapshot {
  committed: number;
  reserved: number;
}

export type MerchantVerdict = 'ALLOWED' | 'BLOCKED' | 'NOT_ALLOWLISTED';

/** Converts to the policy's base currency, or null when no FX rate is configured. */
export function toBase(m: Money, policy: Policy): number | null {
  if (m.currency === policy.baseCurrency) return m.amount;
  const rate = policy.fx[m.currency];
  return rate === undefined ? null : round2(m.amount * rate);
}

function listMatches(merchant: string, list: string[]): boolean {
  const m = merchant.toLowerCase();
  return list.some((entry) => {
    const e = entry.toLowerCase();
    return m === e || m.endsWith(`.${e}`);
  });
}

export function merchantVerdict(merchant: string, policy: Policy): MerchantVerdict {
  if (listMatches(merchant, policy.merchants.block)) return 'BLOCKED';
  if (policy.merchants.allow.length > 0 && !listMatches(merchant, policy.merchants.allow)) return 'NOT_ALLOWLISTED';
  return 'ALLOWED';
}

export function blockedKeyword(text: string, policy: Policy): string | undefined {
  const t = text.toLowerCase();
  return policy.blockedKeywords.find((k) => t.includes(k.toLowerCase()));
}

function finalize(hits: RuleHit[], budget: BudgetSnapshot | null, policy: Policy): PolicyDecision {
  const outcome: PolicyOutcome = hits.some((h) => h.outcome === 'DENY')
    ? 'DENY'
    : hits.some((h) => h.outcome === 'REQUIRE_APPROVAL')
      ? 'REQUIRE_APPROVAL'
      : 'AUTO_APPROVE';
  return { outcome, hits, budget, policyVersion: policy.version };
}

/**
 * Pure, deterministic policy evaluation. Collects every rule that fires (so the agent and the
 * approver see all the reasons at once) and resolves to the strictest outcome:
 * DENY > REQUIRE_APPROVAL > AUTO_APPROVE.
 */
export function evaluate(input: EvaluationInput, policy: Policy, spend: SpendSnapshot): PolicyDecision {
  const hits: RuleHit[] = [];
  const add = (rule: string, outcome: PolicyOutcome, message: string) => hits.push({ rule, outcome, message });

  const dept = policy.departments[input.departmentId];
  if (!dept) {
    add('UNKNOWN_DEPARTMENT', 'DENY', `Departamento desconocido: "${input.departmentId}"`);
    return finalize(hits, null, policy);
  }

  const verdict = merchantVerdict(input.merchant, policy);
  if (verdict === 'BLOCKED') {
    add('MERCHANT_BLOCKED', 'DENY', `El merchant "${input.merchant}" está bloqueado por política`);
  } else if (verdict === 'NOT_ALLOWLISTED') {
    add('MERCHANT_NOT_ALLOWLISTED', 'DENY', `El merchant "${input.merchant}" no está en la lista de permitidos`);
  }

  const keyword = blockedKeyword(`${input.productName} ${input.searchText ?? ''}`, policy);
  if (keyword) {
    add('KEYWORD_BLOCKED', 'DENY', `El artículo coincide con una categoría bloqueada ("${keyword}")`);
  }

  if (input.quantity > policy.maxQuantityPerLine) {
    add('QUANTITY_LIMIT', 'DENY', `Cantidad ${input.quantity} excede el máximo por línea (${policy.maxQuantityPerLine})`);
  }

  const totalBase = toBase(input.total, policy);
  let budget: BudgetSnapshot | null = null;

  if (totalBase === null) {
    // Without a rate the budget and the hard cap cannot be enforced, so fail closed.
    add(
      'CURRENCY_UNSUPPORTED',
      'DENY',
      `Sin tipo de cambio configurado para ${input.total.currency}: no se puede validar presupuesto ni tope (agrega la tasa en "fx")`,
    );
  } else {
    if (totalBase > dept.hardCapPerPurchase) {
      add(
        'HARD_CAP',
        'DENY',
        `Total ${totalBase.toFixed(2)} ${policy.baseCurrency} excede el tope por compra de ${dept.name} (${dept.hardCapPerPurchase.toFixed(2)})`,
      );
    }

    const remainingBefore = round2(dept.monthlyBudget - spend.committed - spend.reserved);
    const remainingAfter = round2(remainingBefore - totalBase);
    budget = {
      departmentId: input.departmentId,
      currency: policy.baseCurrency,
      monthlyBudget: dept.monthlyBudget,
      committed: spend.committed,
      reserved: spend.reserved,
      requested: totalBase,
      remainingBefore,
      remainingAfter,
    };
    if (remainingAfter < 0) {
      add(
        'BUDGET_EXCEEDED',
        policy.overBudgetAction,
        `Presupuesto mensual insuficiente: quedan ${remainingBefore.toFixed(2)} ${policy.baseCurrency}, la compra es ${totalBase.toFixed(2)}`,
      );
    }

    if (totalBase > policy.requireJustificationAbove && input.justification.trim().length < 10) {
      add(
        'JUSTIFICATION_REQUIRED',
        'DENY',
        `Las compras mayores a ${policy.requireJustificationAbove} ${policy.baseCurrency} requieren una justificación (mínimo 10 caracteres)`,
      );
    }
  }

  if (
    input.declaredMaxTotal !== undefined &&
    input.total.amount > input.declaredMaxTotal * (1 + policy.priceTolerancePct / 100)
  ) {
    add(
      'PRICE_DRIFT',
      'REQUIRE_APPROVAL',
      `El total cotizado (${fmt(input.total)}) supera lo que pidió el solicitante (${input.declaredMaxTotal.toFixed(2)}) más ${policy.priceTolerancePct}% de tolerancia`,
    );
  }

  if (totalBase !== null) {
    if (totalBase <= dept.autoApproveUnder) {
      add(
        'WITHIN_AUTO_APPROVE_LIMIT',
        'AUTO_APPROVE',
        `Total ${totalBase.toFixed(2)} ${policy.baseCurrency} dentro del límite de autoaprobación (${dept.autoApproveUnder.toFixed(2)})`,
      );
    } else {
      add(
        'APPROVAL_THRESHOLD',
        'REQUIRE_APPROVAL',
        `Total ${totalBase.toFixed(2)} ${policy.baseCurrency} supera el límite de autoaprobación (${dept.autoApproveUnder.toFixed(2)}): requiere aprobador`,
      );
    }
  }

  return finalize(hits, budget, policy);
}
