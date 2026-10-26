# TallyThis no longer runs on Railway

TallyThis's backend ran on Railway from 9 October 2026. After [Railway's security disclosure of 21 October 2026](https://blog.railway.com/p/security-disclosure-wednesday-october-21st), which said customer environment variables may have been read, the Railway project was deleted and every secret that had been stored there was treated as exposed.

What was done about it, and what is current:

- The backend now runs on a virtual machine in your own Google Cloud project: [GCP_VM_DEPLOYMENT.md](GCP_VM_DEPLOYMENT.md) is the runbook and [DEPLOYMENT.md](DEPLOYMENT.md) the overall picture.
- The Neon database password and the Gemini key were rotated on 24 October 2026; the signing secret and worker token were made fresh. The Cloudflare R2 token and the Anthropic key were kept because the owner judged them not exposed (the runbook says how to replace them).
- The old Railway address `gateway-production-5253.up.railway.app` is gone. In Vercel, `BACKEND_ORIGIN` must be `https://api.tallythis.xyz`.
- Railway's access to the GitHub repository should be revoked (GitHub, Settings, Applications) if it has not been.

This file is kept so that old links resolve. Nothing in it is an instruction to use Railway.
