# TallyThis frontend on Vercel

Import `anshitraj/tally-this`. The frontend is a Vite SPA in a pnpm workspace.

| Vercel setting | Value |
| --- | --- |
| Root Directory | `artifacts/finverify-os` |
| Include source files outside Root Directory | Enabled |
| Framework Preset | Vite |
| Install Command | `pnpm install --frozen-lockfile` |
| Build Command | `pnpm run build` |
| Output Directory | `dist/public` |
| Node.js | 22.x |
| Production Branch | `main`, after merging the deployment changes |

The frontend's `vercel.json` versions the framework, install/build commands, output
directory and current application routes. Root Directory and the outside-source
option remain Vercel project settings. The root package pins pnpm 10.28.0.
Windows native build packages are optional; Linux builders use the platform packages
from Vite/Tailwind's transitive dependencies.

## Diagnose a root 404

1. Check the latest production deployment's branch, commit and build log. A Ready
   deployment does not establish that the intended frontend output was published.
2. Confirm Root Directory and Output Directory above. The generated entry point is
   `artifacts/finverify-os/dist/public/index.html`, not `dist/index.html`.
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

The existing frontend calls relative `/api` URLs. Vite's localhost proxy only works
in development. Once the real Railway HTTPS hostname is available, add this rewrite
before the application rewrites, replacing the example hostname with the actual one:

```json
{
  "source": "/api/:path*",
  "destination": "https://YOUR-RAILWAY-SERVICE.up.railway.app/api/:path*"
}
```

The committed configuration does not invent a backend hostname and does not rewrite
API requests to HTML. Until the Railway proxy is connected, the landing page can be
published, but sign-in, uploads, live client data and exports require the backend.
Configure the backend's public app/OAuth URLs and provider callback registrations
against the final frontend domain. Keep database, session, storage and AI secrets
on the backend.

References: [Vercel Vite SPA routing](https://vercel.com/docs/frameworks/frontend/vite#using-vite-to-make-spas),
[shared monorepo sources](https://vercel.com/docs/monorepos/monorepo-faq#can-i-share-source-files-between-projects-are-shared-packages-supported),
[project configuration](https://vercel.com/docs/project-configuration).
