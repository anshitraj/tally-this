import { useState } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { ArrowLeft, Chrome, Database, Eye, EyeOff, Github, Loader2 } from "lucide-react";
import { login } from "@/lib/auth";
import { peekPendingJob } from "@/components/jobs/jobUi";
import { BrandMark } from "@/components/app/finverify-ui";
import { ProductDemo } from "@/components/marketing/ProductDemo";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const AUTH_TIMEOUT_MS = 20000;
// Loading the sample workspace writes a few hundred rows; give it room on a slow database.
const DEMO_TIMEOUT_MS = 60000;

type AuthMode = "signin" | "register";

interface AuthResponse {
  token: string;
  expiresAt: string;
  user: {
    id: number;
    email: string;
    name: string;
    role: "founder" | "admin" | "ca";
    company: string;
    companyId: number | null;
  };
}

function nextRouteFor(email: string) {
  if (localStorage.getItem(`finverify_onboarding_complete:${email}`) !== "true") return "/onboarding";
  // A file dropped on the home page before sign-in goes straight to its job.
  const job = peekPendingJob();
  return job ? `/app/jobs/${job}` : "/app/overview";
}

async function readAuthResponse(response: Response): Promise<AuthResponse> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Authentication failed");
  }
  return data;
}

async function authFetch(path: string, body: unknown, timeoutMs = AUTH_TIMEOUT_MS): Promise<AuthResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).then(readAuthResponse);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("This is taking longer than usual. Please try again in a moment.");
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
}

export default function LoginPage() {
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<AuthMode>(() => new URLSearchParams(window.location.search).get("mode") === "signup" ? "register" : "signin");
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const initialError = new URLSearchParams(window.location.search).get("error");
  const [error, setError] = useState(initialError ? "OAuth sign-in could not be completed. Please try again." : "");
  const [submitting, setSubmitting] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const endpoint = mode === "register" ? "/api/auth/register" : "/api/auth/login";
      const body = mode === "register"
        ? { name, companyName, email, password }
        : { email, password };
      const data = await authFetch(endpoint, body);

      // A different account may have been in this browser; each sign-in starts with its own clients.
      localStorage.removeItem("finverify_active_client");
      login({
        token: data.token,
        expiresAt: data.expiresAt,
        user: data.user,
      });
      navigate(mode === "register" ? "/onboarding" : nextRouteFor(data.user.email));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  };

  const isRegister = mode === "register";
  const startOAuth = (provider: "google" | "github") => {
    const returnTo = encodeURIComponent(isRegister ? "/onboarding" : "/app/overview");
    window.location.href = `${BASE}/api/auth/${provider}?returnTo=${returnTo}`;
  };

  const handleDemoLoad = async () => {
    setError("");
    setDemoLoading(true);
    try {
      const data = await authFetch("/api/auth/demo", { intent: "load_demo_workspace" }, DEMO_TIMEOUT_MS);

      // A different account may have been in this browser; each sign-in starts with its own clients.
      localStorage.removeItem("finverify_active_client");
      login({
        token: data.token,
        expiresAt: data.expiresAt,
        user: data.user,
      });
      localStorage.setItem(`finverify_onboarding_complete:${data.user.email}`, "true");
      navigate(nextRouteFor(data.user.email));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demo workspace could not be loaded");
    } finally {
      setDemoLoading(false);
    }
  };

  return (
    <div className="fv-login-shell">
      <div className="fv-login-brand-panel">
        <div>
          <div className="mb-8"><BrandMark light /></div>
          <h2 className="text-3xl font-bold text-white mb-4 leading-tight">
            Less entry.<br />More clarity.
          </h2>
          <p className="text-white/70 text-sm">
            Upload a file. Review only what needs attention. Download the result.
          </p>
        </div>
        <div className="fv-auth-preview"><ProductDemo /></div>
        <p className="text-white/40 text-xs">© 2026 TallyThis</p>
      </div>

      <div className="fv-login-form-panel">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="fv-login-form-card"
        >
          <button
            onClick={() => navigate("/")}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to home
          </button>

          <div className="lg:hidden mb-8"><BrandMark /></div>

          <h1 className="text-2xl font-bold mb-1">{isRegister ? "Create your free account" : "Welcome back"}</h1>
          <p className="text-muted-foreground text-sm mb-6">
            {isRegister ? "Takes under a minute. No card needed." : "Sign in to continue."}
          </p>

          <div className="mb-6 grid grid-cols-2 rounded-xl border border-border bg-muted/40 p-1">
            {[
              { id: "signin" as const, label: "Sign in" },
              { id: "register" as const, label: "Create account" },
            ].map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setMode(item.id);
                  setError("");
                }}
                className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                  mode === item.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="mb-5 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => startOAuth("google")}
              className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-sm font-semibold hover:bg-muted/40 transition-colors"
            >
              <Chrome className="h-4 w-4" />
              Google
            </button>
            <button
              type="button"
              onClick={() => startOAuth("github")}
              className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-sm font-semibold hover:bg-muted/40 transition-colors"
            >
              <Github className="h-4 w-4" />
              GitHub
            </button>
          </div>

          <div className="mb-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or use email</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {isRegister && (
              <>
                <div>
                  <label className="text-sm font-medium mb-1.5 block">Your name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Aarav Sharma"
                    className="w-full px-3 py-2.5 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                    required
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1.5 block">Firm or business name</label>
                  <input
                    type="text"
                    value={companyName}
                    onChange={e => setCompanyName(e.target.value)}
                    placeholder="Mehta & Associates"
                    className="w-full px-3 py-2.5 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                    required
                  />
                </div>
              </>
            )}
            <div>
              <label className="text-sm font-medium mb-1.5 block">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full px-3 py-2.5 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                required
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Password</label>
              <div className="relative">
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={isRegister ? "At least 8 characters" : "Your password"}
                  minLength={isRegister ? 8 : undefined}
                  className="w-full px-3 py-2.5 pr-10 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <button
              type="submit"
              disabled={submitting || demoLoading}
              className="fv-brand-accent-bg w-full py-2.5 font-semibold rounded-lg transition-colors text-sm disabled:opacity-60"
            >
              {submitting ? "Working..." : isRegister ? "Create account" : "Sign in"}
            </button>
          </form>

          <div className="mt-5 rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Database className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold">Just looking around?</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Open a sample workspace with example data. Nothing you do there touches a real account.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleDemoLoad}
              disabled={submitting || demoLoading}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2.5 text-sm font-semibold transition-colors hover:bg-muted/50 disabled:opacity-60"
            >
              {demoLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
              {demoLoading ? "Opening sample workspace…" : "Try the sample workspace"}
            </button>

          </div>
        </motion.div>
      </div>
    </div>
  );
}
