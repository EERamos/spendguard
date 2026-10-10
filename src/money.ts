export interface Money {
  amount: number;
  currency: string;
}

/** Rounds to 2 decimals, avoiding float noise such as 0.1 + 0.2. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export const fmt = (m: Money): string => `${m.amount.toFixed(2)} ${m.currency}`;
