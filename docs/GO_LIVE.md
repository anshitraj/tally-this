# Going live: the order of work, and what has and has not been checked

Written 25 October 2026 for branch `release/go-live`. It lists what must happen before real accountants use TallyThis, who does each step, and how to tell it worked. [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) is the wider launch checklist; this page is the short path through it. [TESTING.md](TESTING.md) says what each test layer proves.

## Where things stand

| Place | State |
| --- | --- |
| Code | Branch `release/go-live`, on this computer only: it holds the earlier `phase1/simplify-navigation` and `infra/gcp-vm` branches and the fixes from the full test pass. Nothing from it is on GitHub, so CI has never run it. |
| Backend VM | Running the 24 October release (`052ccfb771`). It answers at `https://api.tallythis.xyz` and on 24 October passed its health, HTTPS, security-header, sign-in-required and reboot checks. It does not have this branch's changes. |
| Database (Neon) | Live. Migration `0004` (indexes, one-account-per-email) is not applied. Read-only checks on 25 October found the live schema matches what the migrations build and no two accounts share an email. Three sample-workspace accounts are disabled. |
| Website (Vercel) | Still points `/api` at the deleted Railway service, so `https://www.tallythis.xyz/api/health` answers 404 and nobody can sign up or sign in on the live site. |

## Steps, in order

Steps 1 to 4 change shared systems, so each needs the owner's go-ahead and is not done by the test tooling.

1. **Publish the code.** Push `release/go-live` and open a pull request to `main`. It already contains everything in the open pull requests 12 and 13 and in the two local branches (over forty commits ahead of `main` on GitHub), so merging it alone is enough; merge 12 and 13 first only if you want smaller steps. Read the CI result; the workflow has not run on GitHub before, so expect to fix a first-run problem. Merge when green.
2. **Check, then apply, the database migration.** Each file runs in one transaction, so if two accounts already share an email the new unique index fails and nothing changes:

   ```bash
   DATABASE_URL=<the production address> pnpm --filter @workspace/db run migrate -- --check
   DATABASE_URL=<the production address> pnpm --filter @workspace/db run migrate -- --remote
   ```

   Keep the address in the environment; the runner never reads a `.env` file.
3. **Deploy the backend** from this branch (or `main` once merged). It sends only committed files, builds on the VM, and puts the previous release back by itself if the new one does not become healthy:

   ```bash
   bash deploy/vm/deploy.sh release/go-live
   node scripts/smoke-live.mjs https://api.tallythis.xyz
   ```

   The second command needs no account and changes nothing: it checks the HTTPS certificate and redirect, that the health answer reports the database, worker and gateway ok without naming any secret, the security headers, that private routes refuse a stranger and a token with no signature, that an unknown address answers a JSON 404, and that another website cannot read answers. It never calls the sample-workspace login.
4. **Point the website at it.** In Vercel set `BACKEND_ORIGIN` to `https://api.tallythis.xyz` for Production (no path, no `/api`) and redeploy. This deployment also ships the new setup screens and the security headers. Then:

   ```bash
   node scripts/smoke-live.mjs https://api.tallythis.xyz --site https://www.tallythis.xyz
   ```

5. **Neon console** (the owner): add `https://www.tallythis.xyz` as a trusted origin, set a custom SMTP sender ([PRODUCTION_READINESS.md](PRODUCTION_READINESS.md#sign-in-email-through-resend)), create your own Google and GitHub sign-in apps, and turn **Allow Localhost** off.
6. **Walk through it yourself on the live site**, as a stranger would, with a fresh email address and the synthetic files in `fixtures/synthetic/`:
   1. Create an account; the six-digit code should arrive (and not in spam); finish the two setup screens.
   2. Drop a bank statement; check the counts match the file, open "Check source values", confirm, generate the Tally file and download it.
   3. Try the other three jobs, then Reports, Activity and History.
   4. Sign out and in again; use password reset; use Google and GitHub sign-in.
   5. Repeat sign-up and one job in **Safari** and on a **real phone**. Neon's session cookie is cross-site, which Safari treats differently, and no test here used Safari or a real phone.
7. **Make failure visible.** An uptime check on `https://www.tallythis.xyz/api/health` that reaches your phone, a budget alert on the Google Cloud billing account, and a look at Neon's restore window. None of these exist yet.
8. **Before real client files:** privacy policy and terms (none are on the site), a decision on `PRIVACY_AI_ALLOWED` (false on the server; leave it false until the paid, no-training setup and the on-screen consent have been checked), who answers `contact@tallythis.xyz`, and the retention and deletion wording. Then `LEGACY_PASSWORD_LOGIN=false` once existing users have moved to the new sign-in.

## What was tested, and what that does and does not show

Everything below ran on 25 October 2026 on one Windows computer, with synthetic files. "Real" means the real worker, TypeScript API, Go gateway and a Postgres; a browser (desktop Chromium and a Pixel 7 screen) drove the built website through the same rewrites and headers Vercel applies. No AI key, no cloud storage and no Neon sign-in were involved.

| Check | Result | It shows | It does not show |
| --- | --- | --- | --- |
| Real-stack browser suite (`pnpm --filter @workspace/finverify-os run test:real`) | 109 pass (4.5 minutes) | Sign-up, setup, every job from upload to download with exact figures, reports, activity, history, settings, privacy mode, team roles, two companies kept apart, sign-in abuse limits, upload limits, a 5,000-row statement, several people at once, a text-layer PDF statement | That Neon sign-in, email, R2, AI reading, a real bank's layout or a real marketplace export behaves the same |
| Quick browser suite (answers pretended) | 89 pass | Every screen renders and behaves as designed | Anything about the backend |
| API unit tests | 214 pass | Parsers, matching, XML builders, permissions, scrubbing, error mapping | Real Tally or GST acceptance |
| Database package | 2 pass | The driver is chosen by host; a real database is never given the local driver | The live Neon connection |
| Deployment configuration | 4 pass | The Vercel configuration, security headers, rewrites | The Vercel dashboard settings |
| Go gateway | pass (format, vet, tests) | Sign-in and permission checks, route table | |
| Python worker | 81 pass | Service token and connector address rules | |
| VM scripts | 26 pass, 1 skipped (a file-mode check that only runs on Linux) | Deploy and secret scripts behave | A deploy to the live VM |
| Typecheck, build, advisory gate | pass | The code compiles and no new serious advisory appeared | |
| Read-only look at production Neon | pass | Schema equals the migrations; no duplicate emails | That migration `0004` applies cleanly there |

## Not checked

- Neon sign-up codes, password reset, Google and GitHub sign-in, and email delivery: these need a live test by the owner (step 6). The local runs use the older password sign-in, because no account may be made on Neon's hosted service from the test tooling.
- A TallyPrime import of any file, and a GST portal upload ([TALLY_IMPORT_ACCEPTANCE.md](TALLY_IMPORT_ACCEPTANCE.md)). Output is described as drafts for CA review.
- Any bank statement layout, marketplace export or Tally export not in the synthetic and regression files; scanned statements; password-protected PDFs from a bank not tried.
- Real cloud storage (R2), real AI providers, the Anthropic fallback (it still needs its workspace id).
- What the Vercel proxy does to long requests (it cuts them at 120 seconds) and to large uploads. `smoke-live.mjs` can probe this after step 4.
- Capacity: one VM is a single point of failure, and no load test was run beyond the 5,000-row and parallel-reader tests.
- Safari, real phones, screen readers.
- Backups restored into an isolated database.

## If something goes wrong after step 3 or 4

- The VM puts the previous release back by itself if the new one is not healthy within the deploy script's wait. To go back by hand, see "Day to day" in [GCP_VM_DEPLOYMENT.md](GCP_VM_DEPLOYMENT.md).
- On Vercel, "Promote" the previous deployment, or set `BACKEND_ORIGIN` back and redeploy.
- Migration `0004` only adds indexes (one of them unique on the email), so leaving it applied should not affect the previous release.
