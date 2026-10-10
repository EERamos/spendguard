# Product

## Register

product

## Users

Primary audience right now: the jury and audience of the Reap x AIBM Agentic Payments hackathon (Mexico City, October 2026), watching a 3-minute live demo on a projector in a lit event room, several meters from the screen. They need to grasp in seconds what happened to each purchase: auto-approved, waiting for a human, denied, paid, reconciled.

Product audience behind the demo: finance leads and department approvers (CFO, CTO, COO) who let AI purchasing agents buy for the company. Their job is to see budgets, approve or reject what needs a human, and trust that no payment link exists before a policy decision.

## Product Purpose

SpendGuard is a spend-policy layer between AI purchasing agents and Reap's Agentic Payments. It quotes every purchase with Reap, judges the real quoted total against company rules (monthly budget per department, auto-approve limit, per-purchase cap, blocked merchants and categories, approvers), and only then lets a Reap payment link exist. After payment it reconciles the final charge against the quote.

Success in the demo: every state change (auto-approve, pending approval, denial, payment, reconciliation flag) is legible from the back of the room, and the dashboard reads as a credible product built on Reap.

## Brand Personality

Precise, trustworthy, calm. Co-branded with Reap: SpendGuard keeps its own name and mark, and borrows Reap's visual language (black structure, teal accent, teal-tinted greys, monospace labels) so it reads as part of the Reap ecosystem without pretending to be a Reap product. Never uses Reap's logo.

Voice: short, factual Spanish. States what happened and why, in the vocabulary of payments (cotización, checkout, conciliación, aprobación).

## Anti-references

- Generic SaaS admin templates: identical stat cards, gradient hero metrics, purple-on-white.
- Crypto neon-on-black dashboards. Reap uses teal on black for its marketing hero, not for a working tool.
- Anything that could be mistaken for an official Reap screen (Reap logo, "Reap" as the product name).
- Decorative motion or glassmorphism that competes with the state of a purchase.

## Design Principles

1. **State first.** The status of each purchase and each budget must be readable at projector distance before any detail.
2. **The rule explains itself.** Every decision shows the rule that produced it and the amount it judged; no unexplained outcomes.
3. **Money is exact.** Amounts are tabular, aligned and carry their currency; quote, final charge and variance are never ambiguous.
4. **Earned familiarity.** Standard table, tabs, forms and buttons, styled with Reap's language; nothing invented for flavor.
5. **Reap's ecosystem, SpendGuard's product.** Borrow the palette and type voice, keep our own identity.

## Accessibility & Inclusion

WCAG 2.2 AA: text contrast at least 4.5:1 (3:1 for large text and UI boundaries), full keyboard navigation with visible focus, status never conveyed by color alone (always a label), and `prefers-reduced-motion` respected. Bright teal (#71f7ec) is never used as text on light surfaces.
