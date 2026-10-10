# Memory

> Architecture decisions. One line each. Format: `# decision: sentence`. Cap enforced by hook.

# stack: TypeScript (strict, ESM, Node >=20.12) + Fastify 5 + zod 4; run with tsx, no build step (`noEmit`).
# architecture: pure domain core (`src/domain/`) + one orchestrator (`src/services/purchase-service.ts`) + Reap adapter with live client and in-memory mock (`src/reap/`) + JSON `Store` (`src/store/store.ts`) + static dashboard (`web/`). Full design in `docs/ARCHITECTURE.md`.
# entrypoint: `src/server.ts` (server + periodic reconciliation poll); REST routes in `src/app.ts`; `scripts/smoke.ts` and `scripts/seed.ts` for end-to-end and demo data.
# testing: vitest (`test/*.test.ts`); done = `npm run typecheck` + `npm test` + `npm run smoke`.
# decision: two approvals — SpendGuard decides whether the charge should exist, Reap's hosted page has the cardholder authorize it; the Reap checkout link is created only after AUTO_APPROVE or an authorized human approval.
# decision: strictest rule wins — DENY > REQUIRE_APPROVAL > AUTO_APPROVE; engine in `src/domain/policy-engine.ts` is pure and returns every rule that fired.
# decision: budget is derived from the request log (`src/domain/ledger.ts`), no separate balance; committed = COMPLETED at final amount, reserved = PENDING_APPROVAL + AWAITING_PAYMENT at quoted total.
# decision: read-spend/evaluate/reserve runs inside an in-process mutex (`src/util/mutex.ts`); single-process only, multi-instance needs a DB transaction or lock behind `Store`.
# decision: idempotency keys are deterministic — `quote:{request}:{attempt}` and `checkout:{request}:{quote}`; create-checkout is NOT retried on 5xx (request goes FAILED, budget released) because Reap caches 4xx/5xx per key for 24 h.
# decision: policy is judged in its base currency (USD default) using the `fx` table; a currency with no rate is DENY (`CURRENCY_UNSUPPORTED`).
# decision: no agent ships in the repo — `src/agent/` is the contract plus policy-safe tools; `POST /api/agent/chat` answers "not connected" until one is wired (`docs/AGENT_INTEGRATION.md`).
# decision: no webhooks — open checkouts are polled every `POLL_INTERVAL_MS`; returning to `returnUrl` never proves an order, always confirm with `GET /agentic/checkouts/{id}`.
# fact: `Money.amount` is a float rounded to 2 decimals (`round2` in `src/money.ts`), not integer minor units — matters for zero- and three-decimal currencies.
# fact: live Reap integration (`Reap-Version 2025-02-14`) follows the docs but is untested against the real sandbox; open checks listed under "Pendientes por validar en live" in `docs/ARCHITECTURE.md`.
