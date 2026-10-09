# TallyThis production launch checklist

Reviewed 9 October 2026. This is a launch plan, not a production certification.

The interface, upload workflows and exports work locally. Production launch still needs security remediation, a tested deployment, and operational setup. A successful workspace build does not prove live DNS, email delivery, backups, tenant isolation or capacity.

## Brand, domain and email

- Product name: **TallyThis**. The custom T/check symbol, forest green wordmark, favicon, landing page, login, workspace, report headings and export filenames use this identity.
- Contact: **contact@tallythis.xyz**. The footer and help page link to it; API support responses default to it. `SUPPORT_EMAIL` can override the API default.
- Website: `https://tallythis.xyz` serves the frontend and proxies `/api/health` successfully, verified on 9 October. Public login and app URLs return HTML; authenticated upload/review/export and OAuth flows still need deployed verification. Mailbox delivery is a separate check.
- Existing package names, database tables, report schema identifiers, browser storage keys and event names retain their existing names for compatibility. They do not determine the public company name.
- Adding a `mailto:` link does not create a mailbox. The email domain must be controlled separately from the website domain if they differ.

## P0: before accepting real client documents

| Area | Required work | Evidence needed to launch |
| --- | --- | --- |
| Authentication | Repair OAuth callback handling and account linking; add email ownership verification and password recovery; limit login/register attempts. | Login, recovery, linking, expired/revoked sessions and malicious redirect checks pass on staging. |
| Permissions | Align Go and Express role checks and client scoping for reads, imports, approvals, downloads and exports. | Founder, CA, finance and viewer tests; a second unrelated workspace cannot access another client's data. |
| Tally connector | Keep customer-run gateways separate from unrestricted server-side network access. Restrict permitted destinations and worker ingress. | Worker is inaccessible publicly; blocked-destination checks pass. A cloud worker's localhost is not a customer's Tally installation. |
| Dependencies | Resolve runtime dependency advisories and rerun Node, Python and Go checks. | Reachable high/critical vulnerabilities closed or documented with verified mitigations. |
| Upload handling | Enforce total request, file count, content type, parser time, page/row and memory limits. Use per-workspace quotas and concurrency limits. | Large, malformed, truncated, encrypted and repeated uploads fail safely without crashing services or duplicating imports. |
| File storage | Configure private R2 and least-privilege credentials. Keep public bucket URLs disabled. Validate storage health at startup and download authorization. | Upload → reopen → download → delete tested using the deployed configuration, including failure/retry cases. |
| Database | Use an isolated production Postgres/Neon database, restricted credentials, encrypted connections and reviewed migrations. | Staging migration and rollback/forward-repair rehearsed; backup restored into an isolated database. |
| Privacy | Publish accurate privacy, terms, retention and AI-provider disclosures; implement deletion/retention behavior that matches them. | Documents, extracted rows, artifacts, logs and backups have defined lifetimes; deletion completion is verified. |
| Deployment | Build and run the actual Linux/container release behind HTTPS, with one public entry point. | All seven main screens and four upload/review/export journeys work through the public proxy, with production settings. |
| Operations | Add alerts for downtime, failed uploads/exports, DB/storage failure, job latency, resource use and unexpected costs. | An alert reaches an operator; restart/recovery and rollback rehearsals succeed. |

The production dependency audit on 8 October reported **1 critical, 15 high, 7 moderate and 2 low advisory entries**. These are registry ratings, not 25 independently confirmed exploits. Runtime reachability and remediation must be reviewed. The local detailed security review is kept outside the public source tree.

## Deployment layout

Keep one HTTPS origin for the browser and `/api`. This avoids the current cross-origin OAuth storage problem and reduces CORS configuration. Keep the database and extraction worker private. The current development browser uses the Go gateway with the Express API behind it; keep that routing until parity and permission tests establish a safe alternative.

```text
Confirmed domain + HTTPS reverse proxy
  ├─ /          → built React/Vite static files
  └─ /api/*     → Go gateway → Express API where applicable
                    │              │
                    └─ Postgres/Neon
                                   ├─ private extraction worker
                                   ├─ private R2 files
                                   └─ optional server-side AI
```

Use a managed container platform or a maintained server with automatic restarts, health checks and restricted ingress. Capacity must be measured with realistic PDFs and concurrent jobs; domain purchase alone does not provide compute, storage or email. Budget separately for database, containers, storage/egress, mailbox, transactional email, monitoring and optional OCR/AI usage. A Kubernetes cluster or a large microservice expansion is unnecessary for the initial pilot.

The folder/deployment revision addresses the build-context mismatch, unsupported
Compose storage setting, missing curl probes and public internal-service ports.
It uses `frontend/` and three `backend/` services, keeps the existing Neon database,
packages API runtime dependencies, preserves PDFKit font assets, and includes OCR
tools in the API image. Compose now uses installed Node/Python/wget probes and its
frontend Nginx configuration has explicit upload/timeout limits. See
[DEPLOYMENT.md](DEPLOYMENT.md) for Vercel and Railway settings.

Remaining deployment work:

- Run actual Linux container smoke tests and verify real upload limits through the Vercel/Railway proxy. Local Docker configuration validation does not prove image execution.
- Keep Railway API and worker private, with only the gateway public. Verify the chosen hosts' ingress configuration.
- Development Caddy configuration serves a Vite dev server and localhost. Production must serve built files and the confirmed hostname.
- Validate Linux native dependencies, frozen-lockfile installs, runtime toolchains, non-root execution, graceful shutdown and deploy rollback. Do not ignore build errors with `|| true`.

## Production configuration

Set secrets through the hosting platform's secret manager, never in frontend code or committed environment files. Do not copy `.env.example` placeholders into production unchanged.

| Setting | Production requirement |
| --- | --- |
| `NODE_ENV`, `APP_ENV` | `production`, explicitly configured for all services |
| `DATABASE_URL` | Production database only, restricted user and encrypted connection |
| `DIRECT_DATABASE_URL` | Migration connection if required; restrict operator access |
| `JWT_SECRET` / `SESSION_SECRET` | Strong randomly generated secret shared consistently where verification requires it; missing secrets must fail startup |
| `APP_URL`, `API_PUBLIC_URL` | Confirmed HTTPS origin; prefer the same public origin |
| OAuth client IDs/secrets and redirect URIs | Exact production `/api/auth/.../callback` URLs; separate staging registrations |
| `CORS_ORIGIN` | Exact authorized origins if cross-origin access is required; no wildcard credential policy |
| `PYTHON_WORKER_URL` | Private network endpoint |
| `STORAGE_PROVIDER` and R2 variables | `r2` with a private bucket and complete scoped credentials |
| `SUPPORT_EMAIL` | `contact@tallythis.xyz` |
| `ALLOW_DEMO_SEED` | `false`; use a separate demo database if needed |
| `HISTORY_MONTHS` | Deliberate display window; this is not a deletion policy |
| AI keys/models/order | Optional, server-side, with cost ceilings and provider contracts reviewed |
| `PRIVACY_AI_ALLOWED` | Leave false unless paid no-training configuration and the displayed consent have actually been verified |

Only public settings belong in frontend build variables. Use separate production/staging databases, file buckets, OAuth credentials and API keys. Do not connect development scripts or synthetic demos to production data.

## DNS, HTTPS and mailbox setup

1. Confirm the website hostname and ownership of the email domain. Enable registrar two-factor authentication, domain lock, renewal and recovery contacts.
2. Add hosting A/AAAA/CNAME records as instructed by the host, verify domain ownership and certificate issuance, and choose one canonical hostname with redirects.
3. Configure the mailbox provider, create `contact@tallythis.xyz`, and add its MX and ownership verification records.
4. Configure SPF, DKIM and DMARC for the providers that actually send mail. Do not publish guessed MX/DKIM values or duplicate SPF records. Test incoming mail, replies and delivery to outside recipients.
5. Configure transactional email for verification, recovery and necessary service notifications. A mailbox service alone does not implement these application flows. Handle bounces and prevent abuse.
6. Add canonical/share metadata and a sitemap for public pages after the domain is confirmed. Keep app data, staging pages and test accounts out of search indexing.

[Cloudflare's official Workspace DNS instructions](https://developers.cloudflare.com/dns/manage-dns-records/how-to/set-up-google-workspace/) explain the mailbox records and authentication. Follow the chosen email provider's own records if using another provider.

## Financial correctness and privacy acceptance

- Test each supported bank/marketplace format with synthetic or consented, protected samples. Validate dates, signs, rounding, opening/closing balance, statement periods, duplicate entries and ambiguous matches.
- Import the generated XML into a test Tally company using supported versions. Confirm ledgers, voucher totals and repeat-import behavior; downloading XML alone is insufficient validation.
- Have an accountant review GST draft mappings, cancellations, refunds, fees, tax amounts and exception behavior. Keep outputs described as drafts for review rather than filing guarantees.
- The marketplace review now supports row, HSN and document-count corrections, uploaded state-wise TCS comparison, Excel, and a Sales voucher XML working copy. These are local features only on the feature branch. GST portal-ready JSON, verified marketplace report layouts, TallyPrime import of Sales vouchers, linked credit notes and settlements still need evidence before launch.
- Verify source links and review decisions persist for saved jobs and remain tied to the correct client. Exceptions must be actionable without revealing parser/provider complexity by default.
- Test the core jobs without AI credentials. Unsupported scans must ask for a readable export or report that reading failed rather than silently return an empty successful result.
- Privacy-mode document reading now permits only Gemini, matching the displayed consent. Verify the paid provider contract, retention and location before setting `PRIVACY_AI_ALLOWED=true`.
- Maintain the [bank evidence matrix](BANK_SUPPORT.md). A recognized bank name or logo does not establish that its statement layout parses or imports correctly.
- Apply the [financial accuracy standard](ACCURACY_STANDARD.md) and [competitor gap list](COMPETITOR_REVIEW.md). Universal “100% accuracy” and feature parity remain unproven. Test every supported format, tax/document treatment and confirmed match on independently checked source data before expanding claims.
- Define the difference between hiding old history, deleting raw files, deleting extracted financial records, deleting an account and expiring backups. A retention date stored in a database is not a scheduled deletion service.
- Publish subprocessors, support/grievance contact, breach response process and customer responsibilities. Have counsel assess applicable Indian privacy requirements and effective dates using the [official MeitY DPDP publications](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa?pageTitle=Digit).
- Review TallyThis naming/trademark implications before investing further in public launch. Use truthful independence statements and avoid presenting bank logos as endorsements. This checklist does not establish trademark clearance.

R2 should remain private: [Cloudflare's documentation](https://developers.cloudflare.com/r2/buckets/public-buckets/) explains that enabling a public domain or `r2.dev` makes objects publicly accessible. Financial documents should use authorized downloads or short-lived signed URLs instead.

## P1: before taking payments or expanding the pilot

- Decide initial pricing, quotas, file-size limits and support response expectations. Test paid access expiry and quota exhaustion.
- Current plans are set by an operator script; automatic billing is not implemented. Manual invoicing can support a small pilot. Automated subscriptions require verified payment webhooks, idempotency, entitlement changes, refunds/cancellations and tax invoice handling reviewed by the business's accountant.
- Fix or clearly disable prototype controls that claim to save without persisting. The current Settings save action displays a toast; it does not itself persist those preferences.
- Add a support inbox workflow and escalation owner; write upload troubleshooting and export/import instructions. Keep the primary onboarding at three steps.
- Establish incident response, credential rotation, dependency patching and regular restoration drills. Protect staff/operator accounts with MFA and least privilege.
- Monitor product usage without collecting document contents, PAN/account numbers, token values or raw financial narration in analytics. Self-host fonts if the chosen privacy/performance policy requires it.
- Add staged CI: build/typecheck, workflow tests, UI navigation/mobile tests, permission/tenant tests, dependency scanning, container build and staging smoke tests. No GitHub Actions pipeline was visible in the inspected tree.
- Reduce the large initial JavaScript bundle through route splitting and measure real user loading/job completion times.

## Release gate

Use a staging environment first. Launch only after the applicable P0 items have evidence and an owner has reviewed the results.

- [ ] Security remediation reviewed and authorization regression tests pass.
- [ ] Frozen install, workspace build, API tests and browser tests pass on the release artifact.
- [ ] Actual container/host smoke test passes, including uploads through the proxy.
- [ ] Two isolated workspaces cannot read or change each other's data or signed downloads.
- [ ] Four core jobs complete upload → exception review → export on desktop and mobile.
- [ ] R2 permission and deletion checks pass; database backup restoration passes.
- [ ] OAuth/recovery/email verification work with the final domain and production providers.
- [ ] Mailbox delivery and alerts tested; no demo data or test credentials in production.
- [ ] Privacy/terms/retention/provider disclosures and support process approved.
- [ ] Rollback and incident ownership documented; paid entitlements match actual billing behavior.

Local verification on 9 October: workspace build/typechecks and API workflow/parser tests passed. The bank review, Excel and navigation browser checks passed, including 360px, 390px and 768px layouts. Incognito adds entitlement, expired-plan, retry, cross-tab, account-switch, mode-lock and mobile checks. Live frontend HTTPS and service health are verified; authenticated live workflows, mailbox delivery, restoration, load testing, real bank and marketplace fixtures, Tally import and a full adversarial tenant test suite remain unverified. See [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md) for branch versus deployment status.
