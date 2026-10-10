# Design

SpendGuard dashboard (`web/`). Plain CSS, tokens on `:root` in `web/styles.css`. Co-branded with Reap: SpendGuard's own name and mark, Reap's visual language. Never Reap's logo.

## Visual theme

Light, on purpose: the primary scene is a hackathon jury watching a projector in a lit room, where dark themes and pale tints wash out. Structure is black (the floating top bar echoes Reap's nav), content sits on teal-tinted neutrals, and Reap teal marks brand and selection. Restrained color strategy: one accent, state colors only where they carry meaning.

## Color

All values in OKLCH, taken from Reap's site tokens (reap.global, October 2026).

| Role | Token | Value | Notes |
|---|---|---|---|
| Page | `--bg` | oklch(97.2% 0.005 197) | Reap tealtinted-grey-100 |
| Surface | `--surface` | oklch(99.6% 0.002 197) | Cards, never pure white |
| Line | `--line` / `--line-strong` | 93.3% / 86.5% | Reap grey-200 / 300 |
| Ink | `--ink` | oklch(21.9% 0.012 196) | 16:1 on `--bg` |
| Secondary ink | `--ink-2` / `--muted` | 43.3% / 52.9% | `--muted` is 4.8:1 on `--bg` |
| Brand | `--teal` | oklch(89.8% 0.119 188) | #71f7ec. Only on dark surfaces (13.4:1 on `--night`) |
| Brand text | `--teal-800` / `--teal-900` | 53.7% / 37.8% | Links, focus ring; 4.9:1 on white |
| Selection | `--teal-200` / `--teal-100` | 94.2% / 97.9% | Selected row / your department |
| Structure | `--night` / `--night-2` / `--night-line` | 21.9% / 27% / 36% | Top bar, primary buttons, active tab, user messages |
| States | `--ok` `--warn` `--bad` `--info` + `-soft` | | Each text color passes AA on its own tint. Info is Reap blue-700 |
| Budget | `--committed` / `--reserved` | teal-800 / Reap peach | Reserved is striped, never color alone |

Rules: bright teal is never text on light surfaces. State is always a word plus a color (badges, policy hits with ✓ ! × glyphs).

## Typography

- **Geist** (UI, data) and **Geist Mono** (labels, IDs, chips, counters), loaded from Google Fonts with system fallbacks so the page works offline. Reap's display face (PolySans) is licensed and not used.
- Base 15px / 1.5. Scale: 11 to 12.5 mono labels (uppercase, 0.08em tracking), 13 to 15 body, 17 to 20 titles, 30 budget figures.
- Money and times use tabular figures.

## Components

- **Top bar**: floating black bar inside a solid `--bg` sticky wrapper (`.appbar`). Brand mark is "SG" in Geist Mono on teal. Fits one row at 1280px (hides the policy chip and "Agentic Payments" at ≤1440px).
- **Budget strip**: one panel split by 1px rules (Reap's stat band), not three cards. Your department gets `--teal-100` and a "Tu depto." tag.
- **Buttons**: default (surface + line), primary (night + teal text), ok (approve), danger (reject, outlined), ghost. All have hover, active, focus-visible and disabled states; 36px min height, 48px for the payment link.
- **Tabs (filters)**: pills; active is night with a teal count.
- **Requests table**: 4 columns (product + merchant/time, department + requester, total, status). Rows are focusable and open with Enter or Space; focus survives re-renders.
- **Policy hits**: tinted rows with a leading glyph circle. No side-stripe borders.
- **Timeline**: dot + rule, dot color by event tone.
- **Toasts**: night, ok or bad; 220ms ease-out-quart entrance.

## Layout

- Max width 1680px, 24px gutters (16px under 940px).
- Workspace: 3 columns ≥1641px (chat, requests, detail 440px); 2 columns down to 941px (detail 400px under 1100px); 1 column below.
- Radius 14px for panels, 9px for controls.

## Motion

150ms color transitions, 220ms toast entrance, ease-out-quart. No layout-property animation. Everything off under `prefers-reduced-motion`.
