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
# fact: live Reap (sg sandbox, `Reap-Version 2025-02-14`) validated 2026-10-09 for search, details and quote; checkout create still unverified until the enrollment is ACTIVE.
# fact: Reap quote `email` rejects reserved TLDs (`.test`, `.example`) with a misleading `field: shippingAddress` error; `@example.com` passes -> `REAP_CONTACT_EMAIL` overrides the requester email sent to Reap.
# fact: Reap checkout body is `{ quoteId, enrollmentId, presentation }` — no `owner`; `returnUrl` must be HTTPS (http://localhost is 422) -> `REAP_ENROLLMENT_ID` + `PUBLIC_BASE_URL=https://...`.
# fact: enrollment = `POST /agentic/enrollments` `{ source: "EXTERNAL", owner: { type: "CLIENT_REFERENCE", id, email }, presentation }`; the human enters the card on `nextAction.url`; only `ACTIVE` can be charged.
# fact: in live, `merchant` is a display name ("Baseus US", "Arzopa"), not a domain, so `merchants.block` domain matching probably misses (unverified); keyword and cap rules still apply.
# decision: MCP server `src/mcp/server.ts` (stdio) is a thin proxy to `POST /api/agent/tool` -> `AgentToolbox`; one process keeps mutex, store and dashboard; identity from `SPENDGUARD_USER_EMAIL`/`SPENDGUARD_DEPARTMENT` env, never from the model.
# fact: Reap enrollment needs a Visa payment passkey on the hosted page ("Not now" cancels card setup); `X-Simulate-Checkout: COMPLETED` still returns `409 ENROLLMENT_NOT_ACTIVE` without an ACTIVE enrollment. On 2026-10-09 the passkey failed on Windows ("Maximum Attempts Reached") and on a phone ("card processing failing").
# fact: enrollment `0add3f59-195c-4176-8d3d-bf7d079c35fd` went ACTIVE (VISA 7847) on 2026-10-09 after deleting the stale `sandbox.auth.visa.com` passkey in Windows (Settings > Accounts > Passkeys); a leftover passkey from a failed attempt blocks later enrollments.
# fact: sandbox checkouts need `X-Simulate-Checkout: COMPLETED` (`REAP_SIMULATE_CHECKOUT=COMPLETED`); without it the passkey step passes but the checkout ends `FAILED` because the real store declines the test card. With it: `COMPLETED`, order `ord_01M4HSHEXM1XBY2ABJS945CAN4`, 15.58 USD (direct API test, not yet through SpendGuard).
# decision: `REAP_CHECKOUT=simulated` -> `HybridReapClient` (`src/reap/hybrid.ts`): search/details/variant/quote go to live Reap, checkout approval is simulated on `/mock/reap/approve/:id` with a banner and `SIM-` order ids. Needs `PUBLIC_BASE_URL=http://localhost:3000`; real checkout needs `REAP_CHECKOUT=live`, an ACTIVE `REAP_ENROLLMENT_ID` and an https `PUBLIC_BASE_URL`.
# decision: MCP uses the SDK low-level `Server` so `TOOL_DEFINITIONS` JSON Schemas are passed as-is (no zod coupling with the SDK).
