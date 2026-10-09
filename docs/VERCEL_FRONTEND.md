# TallyThis frontend on Vercel

Import `anshitraj/tally-this`. The frontend is a Vite SPA in a pnpm workspace.

| Vercel setting | Value |
| --- | --- |
| Root Directory | `frontend` |
| Include source files outside Root Directory | Enabled |
| Framework Preset | Vite |
| Install Command | `pnpm install --frozen-lockfile` |
| Build Command | `pnpm run build` |
| Output Directory | `dist/public` |
| Node.js | 22.x |
| Production Branch | `main`, after merging the deployment changes |

The frontend's `vercel.mjs` versions the framework, install/build commands, output
directory and current application routes. Root Directory and the outside-source
option remain Vercel project settings. The root package pins pnpm 10.28.0.
Windows native build packages are optional; Linux builders use the platform packages
from Vite/Tailwind's transitive dependencies.

## Diagnose a root 404

1. Check the latest production deployment's branch, commit and build log. A Ready
   deployment does not establish that the intended frontend output was published.
2. Confirm Root Directory and Output Directory above. The generated entry point is
   `frontend/dist/public/index.html`, not `dist/index.html`.
3. Check the deployment's output files for `index.html`, `favicon.svg`, `assets/`
   and `brands/`. A deployment serving only the source `public/` directory will not
   contain the application entry point.
4. In Settings → Domains, verify that the intended public hostname is assigned to
   this project and production environment. A protected deployment URL may require
   Vercel sign-in; use the assigned public production hostname for public testing.
5. Redeploy after correcting settings or merging configuration changes. Test `/`,
   `/login`, `/app/overview`, `/favicon.svg` and a generated JavaScript asset.

The 2026-10-08 investigation confirmed GitHub recorded a successful Vercel production
deployment of merge commit `da36363`. Public `tally-this.vercel.app` nevertheless
returned Vercel `NOT_FOUND` at `/`, `/index.html`, `/favicon.svg` and `/app/overview`.
The authenticated project settings and deployment output were not available to this
session, so an output mismatch versus a hostname assignment cannot yet be confirmed.

## Connect Railway before enabling real jobs

The frontend calls relative `/api` URLs. Set **`BACKEND_ORIGIN`** in Vercel to
its actual public HTTPS Railway **gateway** origin, without `/api`, for example
`https://your-actual-gateway.up.railway.app`. `frontend/vercel.mjs` reads this at
deployment time and inserts the `/api/:path*` proxy before application routes.
Redeploy after changing the variable. Do not invent a hostname or add backend
credentials to frontend variables.

Leaving `BACKEND_ORIGIN` blank publishes the landing page only; sign-in, uploads,
live data and exports require the backend. API requests never fall through to HTML.
Configure backend app/OAuth URLs against the final frontend domain.

The reorganized repository uses **`frontend`** as the Vercel Root Directory.
Change the old `artifacts/finverify-os` setting when deploying this branch.
Complete Railway and storage instructions are in [DEPLOYMENT.md](DEPLOYMENT.md).

References: [Vercel Vite SPA routing](https://vercel.com/docs/frameworks/frontend/vite#using-vite-to-make-spas),
[shared monorepo sources](https://vercel.com/docs/monorepos/monorepo-faq#can-i-share-source-files-between-projects-are-shared-packages-supported),
[project configuration](https://vercel.com/docs/project-configuration).
