# TallyThis on a Google Cloud VM

TallyThis's backend (gateway, API and worker) runs in Docker on one virtual machine in your own Google Cloud project. The frontend stays on Vercel. This replaced Railway after [Railway's 21 October 2026 security disclosure](https://blog.railway.com/p/security-disclosure-wednesday-october-21st), which said customer environment variables may have been read.

Nothing here has been used by real customers. See "Not verified" at the end.

## What is where

```text
Browser ── https://www.tallythis.xyz (Vercel: the website, and a proxy for /api)
              │
              └─ https://api.tallythis.xyz ──► VM tallythis-1, Google Cloud, Singapore
                                                 │  only ports 80 and 443 are open
                                                 ▼
                                               Caddy (HTTPS certificate, renews itself)
                                                 ▼   private Docker network, no published ports
                                               gateway ──► api ──► worker
                                                              │
                              Neon (database, sign-in) ◄──────┤
                              Cloudflare R2 (uploaded files) ◄┤
                              Gemini / Claude (AI, optional) ◄┘
```

| Thing | Value |
| --- | --- |
| Google Cloud project | `gen-lang-client-0617032862` (named Railor). Everything TallyThis made is called `tallythis-*`; nothing else in the project was touched. |
| VM | `tallythis-1`, zone `asia-southeast1-b` (Singapore, next to the Neon database), `e2-standard-4` (4 vCPU, 16 GB), 100 GB disk, Debian 12, deletion protection on |
| Public address | `35.240.201.229`, a reserved address that stays with the VM |
| Network | its own VPC `tallythis-vpc`; the project's `default` network is not used |
| Service account | `tallythis-vm`: can read the seven `tallythis-*` secrets and write logs and metrics, nothing else |
| Secrets | Google Secret Manager, stored in `asia-southeast1`, names start with `tallythis-` |
| Backups | the disk is snapshotted daily and kept 14 days. The VM holds no data of its own (files are in R2, records in Neon), so a snapshot only saves you rebuilding the VM. |

## Why it is built this way

- **No platform stores your secrets.** Passwords and keys live in Secret Manager. At start the VM's own identity (no key file anywhere) copies them into memory, and each container gets only the ones it needs: the gateway gets the database address and signing secret, the API gets those plus the worker token, the storage keys and AI keys, and the worker gets only the worker token.
- **One door.** Only Caddy listens to the internet. The API and worker publish no ports at all, so they cannot be called from outside, even by mistake.
- **No open SSH.** Port 22 is reachable only through Google's identity-aware proxy, so logging in needs your Google sign-in.
- **Only committed code is deployed.** `deploy.sh` sends `git archive` of a commit, so a local `.env` or an unfinished edit cannot reach the server.
- **A bad release rolls itself back.** The installer waits for all three services to report healthy and restores the previous release if they do not.

## First time

Do these in order. Steps 1 and 2 are yours; the rest are scripted.

1. **Rotate every secret that was ever stored in Railway.** Treat them all as exposed:
   - Neon: reset the password of the database role the app uses (Neon console, Roles), and use the new connection string. This also changes your local `.env`.
   - Cloudflare R2: delete the old API token and create a new one limited to the `finverify` bucket.
   - Gemini and Anthropic: create new keys and delete the old ones. Look at the usage pages for anything you did not do.
   - Any other key you ever put in a Railway variable (NVIDIA, OpenRouter, OAuth secrets).
   - Revoke Railway's access to your GitHub repository (GitHub, Settings, Applications) and run `railway logout` on this computer. The signing secret and the worker token do not need rotating by hand; they are made fresh in step 3.
2. **Point DNS at the VM.** In Cloudflare add an `A` record: `api` → `35.240.201.229`, **DNS only** (grey cloud). Caddy cannot get its certificate through the proxy.
3. **Put the new secrets into Secret Manager.** In Git Bash from the repository folder:
   ```bash
   bash deploy/vm/set-secrets.sh
   ```
   It asks for each value with hidden input and sends it straight to Google. It also makes the two internal secrets at random. Nobody else, including Claude, sees what you type.
4. **Deploy.**
   ```bash
   bash deploy/vm/deploy.sh
   ```
   The first build takes several minutes. It ends with the three services healthy, or with the reason and the previous release restored.
5. **Point the website at it.** In Vercel set `BACKEND_ORIGIN` to `https://api.tallythis.xyz` (no path, no `/api`) and redeploy the frontend.
6. **Check it.** `curl https://api.tallythis.xyz/api/health` should report the API, worker and database as `ok`. Then sign in on the website and run one job.

`deploy/vm/config.sh` and `deploy/vm/runtime.env` hold the settings for this deployment. They are git-ignored; the `.example` files next to them show the shape. `runtime.env` holds nothing secret.

## Day to day

| To do this | Run |
| --- | --- |
| Deploy the latest commit | `bash deploy/vm/deploy.sh` |
| Deploy a branch or commit | `bash deploy/vm/deploy.sh <git-ref>` |
| Open a shell on the VM | `bash deploy/vm/ssh.sh` |
| See what is running | `bash deploy/vm/ssh.sh 'sudo docker ps'` |
| Read the logs | `bash deploy/vm/ssh.sh 'sudo journalctl -u tallythis -n 200 --no-pager'` |
| Change a non-secret setting | edit `deploy/vm/runtime.env`, then `deploy.sh` |
| Change a secret | `bash deploy/vm/set-secrets.sh`, then `bash deploy/vm/ssh.sh 'sudo systemctl restart tallythis'` |
| Make the signing secret new (signs everyone out) | `bash deploy/vm/set-secrets.sh --rotate`, then restart as above |
| Go back to the previous release by hand | `bash deploy/vm/ssh.sh 'ls /opt/tallythis/releases'`, then deploy that commit again |
| Use a bigger machine | stop the VM, change its machine type in the console, start it |

The service starts by itself after a reboot, fetching the secrets again first.

## Costs

A VM of this size runs about a hundred dollars a month at list price, plus the disk and a little network traffic, well inside the budget you gave. Check the Google Cloud pricing calculator and set a budget alert in the billing console before relying on the figure. The daily snapshots cost very little.

## Not verified

- The deployment has not carried real customer traffic and has never started with real secrets. What was checked on 24 October 2026: the provisioning script ran against the project; the VM boots, installs Docker and accepts SSH through the proxy; **all three images (gateway, API, worker) built successfully on the VM**; the release installer reached the start step and stopped there because the secrets had no values yet; and the secret-handling script passes its tests against a fake Google. Not yet seen: the stack running, the HTTPS certificate being issued, and the website talking to it.
- **Vercel's proxy cuts any request at 120 seconds** ([Vercel limits](https://vercel.com/docs/limits)). A scan the AI reads for longer than that will fail when it goes through the website, whatever hosts the backend. This is not new. Fixing it means either calling the backend directly from the browser or making long reads run in the background; it is a Phase 1 item.
- Vercel's limit on the size of an uploaded file through that proxy is not published; try a large statement through the website before relying on 60 MB.
- One VM is one point of failure. If it stops, the site's backend is down until it restarts (usually a minute or two). Two VMs behind a load balancer is the next step if that matters.
- Neon (database and sign-in) and Cloudflare R2 (files) are still outside your Google project. Moving files into Google Cloud Storage is possible; moving the database is not simple, because sign-in is stored in Neon.
- Caddy's access log records the address of each request, including query strings. Nothing sensitive is meant to be in a query string, but the logs stay on the VM.
