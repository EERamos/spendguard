import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const DepartmentSchema = z.object({
  name: z.string().min(1),
  monthlyBudget: z.number().nonnegative(),
  /** Totals at or below this (in baseCurrency) skip the internal approver. */
  autoApproveUnder: z.number().nonnegative(),
  /** Totals above this are denied outright. */
  hardCapPerPurchase: z.number().positive(),
  /** Emails allowed to approve this department's requests. Empty = anyone. */
  approvers: z.array(z.string()).default([]),
});

export const PolicySchema = z.object({
  version: z.number().int().positive(),
  baseCurrency: z.string().length(3),
  /** Multiplier from foreign currency to baseCurrency, e.g. { "MXN": 0.055 }. */
  fx: z.record(z.string(), z.number().positive()).default({}),
  overBudgetAction: z.enum(['DENY', 'REQUIRE_APPROVAL']).default('DENY'),
  allowSelfApproval: z.boolean().default(false),
  requireJustificationAbove: z.number().nonnegative().default(0),
  /** Quote may exceed the requester's declared max by this % before it needs approval. */
  priceTolerancePct: z.number().nonnegative().default(10),
  /** Final charge may differ from the quote by this % before reconciliation flags it. */
  reconciliationTolerancePct: z.number().nonnegative().default(1),
  maxQuantityPerLine: z.number().int().positive().default(50),
  merchants: z
    .object({
      allow: z.array(z.string()).default([]),
      block: z.array(z.string()).default([]),
    })
    .default({ allow: [], block: [] }),
  blockedKeywords: z.array(z.string()).default([]),
  departments: z.record(z.string(), DepartmentSchema),
});

export type Policy = z.infer<typeof PolicySchema>;
export type DepartmentPolicy = z.infer<typeof DepartmentSchema>;

export function loadPolicyFile(file: string): Policy {
  if (!existsSync(file)) throw new Error(`Policy file not found: ${file}`);
  return PolicySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** Holds the live policy. Replacing it validates, bumps the version and persists to disk. */
export class PolicyProvider {
  private policy: Policy;

  constructor(
    private readonly file: string | null,
    initial?: Policy,
  ) {
    if (initial) this.policy = initial;
    else if (file) this.policy = loadPolicyFile(file);
    else throw new Error('PolicyProvider needs a file or an initial policy');
  }

  get(): Policy {
    return this.policy;
  }

  replace(next: unknown): Policy {
    const parsed = PolicySchema.parse(next);
    this.policy = { ...parsed, version: this.policy.version + 1 };
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.policy, null, 2) + '\n');
    }
    return this.policy;
  }
}
