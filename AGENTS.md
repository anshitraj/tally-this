# FinVerify OS Agent Instructions

==================================================
NON-NEGOTIABLE SIMPLICITY RULE
==================================================

FinVerify must be extremely easy to learn and use.

Optimize for a CA/accountant who does NOT want to understand the software.

The core user journey must always feel like:

Select Client
→ Select Job
→ Upload File
→ Review only what needs attention
→ Export

Do not expose system complexity by default.

Product principle: **Simple by default, powerful only when needed.**

A 7-feature product that feels effortless is the goal. Do not add surface area that requires training.

The primary interface shows only:

- Clients
- Bank → Tally
- Bank ↔ Tally
- E-commerce GST
- Invoice ↔ Bank
- Reports
- Activity

Everything else is hidden under **Advanced**, **Show details**, or **More options**: raw parsed data, AI confidence, column mapping, evidence metadata, run IDs, parser selection, provider details, technical logs, and complex reconciliation options.

MAIN UX RULES:

- One obvious primary action per screen.
- Maximum 1–2 secondary actions visible.
- Everything advanced goes behind:
  “Show details”
  “Advanced”
  “More options”

Do not show by default:

- raw parsed rows
- internal run IDs
- database terminology
- parser/provider names
- AI provider details
- raw confidence metadata
- JSON
- column mappings
- technical logs
- advanced reconciliation settings
- source evidence internals

Only show these when the user explicitly opens Advanced View.

Onboarding must be maximum 3 steps:

1. Create account
2. Add client
3. Choose automation

Do not require GSTIN, PAN, state, industry, payroll provider, gateway provider, or other optional information before the user can use the product.

Ask for additional information only when the selected workflow actually needs it.

Every workflow should have:

- one clear title
- one sentence explaining the outcome
- one primary CTA
- simple progress
- clear result
- clear export/download action

For every workflow:

One page
One obvious primary action
At most 1–2 secondary actions
Everything else under “More options”

Examples:

Bank Statement → Tally

Upload your bank statement and get a Tally-ready file.

[Upload Bank Statement]

After processing:

347 transactions detected
3 need review

[Generate Tally File]

The first view is only: upload, detected bank and transaction count, generate, and a link to review uncertain rows. Do not show parsing metadata cards.

--------------------------------

Bank ↔ Tally

Upload bank statement and Tally export to find mismatches.

[Upload Files]

After processing:

312 matched
17 need attention

[Review 17 Items]

--------------------------------

E-commerce GST

Upload marketplace reports and prepare GST-ready data.

[Upload Marketplace Reports]

After processing:

Data ready
4 items need review

[Generate GST Reports]

--------------------------------

Invoice ↔ Bank

Upload invoices and bank statement to find missing or unmatched payments.

[Upload Files]

After processing:

28 matched
5 need attention

[Review 5 Items]

The user should never have to ask:
“What should I click next?”

FinVerify must always answer that through the UI.

PRODUCT PRINCIPLE:

Simple first.
Details on demand.
Exceptions, not dashboards.
Jobs, not database entities.
Outputs, not configuration.

## Product
FinVerify OS is a pre-CA finance verification layer for Indian startups. It verifies bank statements, invoices, Tally/Zoho exports, GST/TDS files, payroll, expenses, and payment gateway settlements before CA review.

## Design Standard
Build a YC-quality fintech SaaS UI inspired by Linear, Vercel, Stripe, Mercury, Ramp, Brex, Deel, and Razorpay.

## Visual Rules
- Professional fintech, not crypto.
- Use off-white background, dark slate text, orange accent.
- Keep UI clean, spacious, and high-trust.
- Use consistent cards, badges, buttons, spacing, and typography.
- Avoid purple AI gradients, neon colors, random emojis, and generic SaaS templates.
- Use subtle motion only.

## Product Rules
- Do not claim direct Tally/GST/bank integrations are live unless implemented.
- Current version is upload-based unless a feature explicitly proves otherwise in code.
- Use "Potential risk — needs CA review." for compliance issues.
- AI is optional, rule-first, and never the source of financial truth.
- The app must run without an AI API key.
- Preserve existing reconciliation logic, demo data, reports, and uploads.
- Do not remove working pages or sample data while redesigning.

## Engineering Rules
- Prefer incremental typed changes over broad rewrites.
- Prefer modular services and reusable UI components for parsing, matching, risk generation, exports, and display patterns.
- Keep README accurate about what is real, mocked, upload-based, or future work.
- Never expose API keys client-side, log them, or commit `.env` files.
- Never hardcode AI model names except safe defaults; read provider models from env/config.
- Never use AI as the financial source of truth. Deterministic matching is authoritative.
- Never claim legal, tax, GST, TDS, audit, or fraud certainty.
- Always validate AI JSON against schemas before using it.
- Always provide rule-based fallback when AI providers fail.

## Verification
Before finishing any UI or backend task:
- Run build/typecheck if available.
- Check mobile responsiveness.
- Review visual consistency.
- Confirm no routes are broken.
- Run the workspace build before final response.
