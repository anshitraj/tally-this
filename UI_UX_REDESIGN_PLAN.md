# FinVerify OS UI/UX Redesign Plan

## Audit Summary
The app is a working pnpm monorepo. The product frontend lives in `frontend` and already has React, TypeScript, Vite, Tailwind, shadcn-style primitives, Recharts, Framer Motion, Lucide icons, Wouter routes, and API-backed pages. The API and demo logic live in `backend/api`, including upload parsing, seeded finance records, matching, risks, reports, and platform data.

Current UI issues observed:
- Good product coverage, but page layouts use mixed card sizes, spacing, and ad hoc badge colors.
- The landing page communicates the product, but the hero mockup and sections need a more premium single-composition feel.
- Dashboard pages need a stronger control-room hierarchy: score, readiness, exceptions, uploads, and CA queue should scan quickly.
- Tables need tighter alignment, sticky headers, confidence treatment, empty states, and mobile overflow behavior.
- Some copy and currency strings contain encoding artifacts and should be cleaned where touched.
- Integrations need continued clarity between upload-based support and future direct connectors.
- Motion is present but needs reduced-motion handling and less visual noise.

## Implementation Plan
1. Add durable repo instructions in `AGENTS.md`.
2. Document design rules in `DESIGN_SYSTEM.md` and this plan.
3. Introduce `src/styles/design-tokens.css` and import it from the global stylesheet.
4. Add reusable app UI components for brand, sections, cards, badges, confidence bars, upload cards, integrations, reports, review queue items, data tables, and page transitions.
5. Upgrade the landing page around a polished product mockup and the requested sections.
6. Upgrade the app shell with a cleaner sidebar, topbar, role badge, search, month selector, upload action, and responsive behavior.
7. Refresh overview, uploads, transactions, reconciliation, risks, CA review, reports, integrations, and settings while preserving existing data fetching and mutations.
8. Run `pnpm run typecheck` and `pnpm run build`.
9. Start the local app and run a visual smoke test across core routes.

## Product Guardrails
- Upload-based workflows are real in the prototype.
- Direct Tally, GST/GSP, bank feeds, Gmail, WhatsApp, and gateway APIs remain future work unless implemented.
- AI is optional and rule-first.
- Compliance issues are potential risks requiring CA review.
