# TallyThis frontend

This is the React/Vite landing page and accounting workspace.

In Vercel select Root Directory **`frontend`**, Vite, Node 22.x and include
source files outside the Root Directory. Build: `pnpm run build`.
Output: **`dist/public`**. pnpm is pinned in the repository root.

Set **`BACKEND_ORIGIN`** in Vercel to the public HTTPS Railway gateway origin,
without `/api`. `vercel.mjs` creates the same-origin `/api` proxy and routes for
login, onboarding and dashboard refreshes. Redeploy after changing this variable.
Leaving it blank supports the public landing page only.

Local commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev:frontend
pnpm build:frontend
```

Database, R2, OAuth secrets and AI keys belong on backend services. Never use
`VITE_` variables for secrets. See [the deployment guide](../docs/DEPLOYMENT.md).
