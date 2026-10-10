# Todo

> Open work only. Status: `pending` / `in_progress`. Done → move to `results.md`. Cap enforced by hook.

- [ ] [pending] Real Reap checkout through SpendGuard/MCP: enrollment is ACTIVE and a direct API checkout COMPLETED; still to run via the app with `REAP_CHECKOUT=live`, `REAP_SIMULATE_CHECKOUT=COMPLETED`, https `PUBLIC_BASE_URL`. Waiting on the user's choice of demo mode.
- [ ] [pending] Verify `.mcp.json` loads in Claude Code itself (only an SDK stdio client was used so far).
- [ ] [pending] HTTPS return URL: `PUBLIC_BASE_URL=https://localhost:3000` passes Reap validation but the browser cannot load it after payment; a tunnel would land the user back on the dashboard.
- [ ] [pending] Live merchant is a display name, not a domain: check `merchants.block` matching against live results.
- [ ] [pending] `docs/ARCHITECTURE.md` "Pendientes por validar en live" still describes `owner` and no `enrollmentId`; update after checkout is verified.
