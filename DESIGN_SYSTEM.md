# FinVerify OS Design System

## Brand
FinVerify OS is a serious, high-trust fintech SaaS product for Indian startups, finance teams, and CAs. The refreshed identity should feel stable, precise, and growth-oriented, with enough technical edge for dense verification workflows.

Wordmark treatment:
- "Fin" uses deep green `#065F46`.
- "Verify" uses gold-orange `#F97F06`.
- "OS" sits in a teal `#0D9488` pill with white letters.
- Use the same geometric sans-serif as the UI.
- Horizontal and stacked assets live in `frontend/public/wordmark-horizontal.svg`, `wordmark-horizontal.png`, `wordmark-stacked.svg`, and `wordmark-stacked.png`.

## Palette
Core CSS tokens live in `frontend/src/styles/design-tokens.css`.

- Primary / deep green: `#065F46`
- Secondary / teal: `#0D9488`
- Accent / gold-orange: `#F97F06`
- Neutral / soft taupe: `#78716C`
- Background: `#FAFAF9`
- Surface: `#FFFFFF`
- Surface muted: `#F5F5F4`
- Text primary: `#101828`
- Text secondary: `#667085`
- Border: `#E7E5E4`
- Border strong: `#D6D3D1`
- Risk: `#DC2626`

## Typography
Use Manrope as the product font. It is geometric enough for a modern SaaS surface and readable in tables.

- Display: 64/72, weight 800
- H1: 48/56, weight 800
- H2: 36/44, weight 700
- H3: 24/32, weight 700
- Body: 16/24, weight 400-500
- Data/table: 14/20, weight 500
- Caption: 12/16, weight 600 for labels

Keep the scale strict. Do not introduce many one-off font sizes.

## Spacing
Use an 8px system: 4, 8, 12, 16, 24, 32, 48, 64, 96.

## Components
Cards:
- 1px border using `#E7E5E4`.
- 16px or 20px radius.
- 20-28px padding.
- Subtle green-tinted shadow only.
- No heavy glassmorphism.

Buttons:
- Primary: gold-orange background `#F97F06`, darker orange hover, white text.
- Secondary: teal outline and teal text, light teal hover.
- Ghost: taupe outline and neutral text, subtle neutral hover.

Navigation:
- Sidebar uses deep green with off-white content containers.
- Active navigation state uses gold-orange.
- Top app bar uses off-white with charcoal text.

Status badges:
- Verified / CA-ready: green.
- Unverified: taupe.
- Risky: red.
- Missing / duplicate / partial: amber-gold.
- CA review / upload-based: teal.

Tables:
- Sticky headers where useful.
- Horizontal scroll on narrow screens.
- Clear row hover using a light teal tint.
- Numeric columns right aligned.
- Status and confidence shown consistently.

Charts:
- Use green, teal, gold-orange, red, and taupe in that order.
- Avoid saturated blue/purple chart colors.
- Keep gridlines low-contrast stone.

## Motion
Use subtle motion only:
- Light page fade/slide.
- Cards stagger on first load.
- Progress bars animate once.
- Buttons can translate 1px on hover.
- Respect `prefers-reduced-motion`.

## Product Copy
- Never imply this is accounting software or a CA replacement.
- Never claim live direct integrations unless implemented.
- Compliance and tax findings must be framed as "Potential risk — needs CA review."
- AI should be described as rule-first and optional.

## Legacy Notes
- `frontend/src/index.css` still contains a Tailwind inline safelist with some historical blue/amber/emerald utility names. Those are safelisted strings, not the active visual identity.
- New UI work should prefer semantic CSS variables from `design-tokens.css` over raw color utility classes.
