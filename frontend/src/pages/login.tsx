import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { ArrowLeft, Chrome, Database, Eye, EyeOff, Github, Loader2 } from "lucide-react";
import { login } from "@/lib/auth";
import { peekPendingJob } from "@/components/jobs/jobUi";
import { BrandMark } from "@/components/app/finverify-ui";
import { ProductDemo } from "@/components/marketing/ProductDemo";
import {
  NeonAuthError,
  exchangeForSession,
  loadNeonConfig,
  neonResetPassword,
  neonSendCode,
  neonSignIn,
  neonSignUp,
  neonSocialStart,
  neonToken,
  neonVerifyEmail,
  type NeonConfig,
  type TallySession,
} from "@/lib/neonAuth";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const AUTH_TIMEOUT_MS = 20000;
// Loading the sample workspace writes a few hundred rows; give it room on a slow database.
const DEMO_TIMEOUT_MS = 60000;

type AuthMode = "signin" | "register";
// "form" is the normal page; the others are the email-code steps when Neon Auth is on.
type Step = "form" | "code" | "forgot" | "reset";

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
  const [neon, setNeon] = useState<NeonConfig | null>(null);
  const [step, setStep] = useState<Step>("form");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [info, setInfo] = useState("");

  useEffect(() => {
    void loadNeonConfig().then(setNeon);
  }, []);

  // A person returning from Google or GitHub arrives here with a note from Neon in the address.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("neon_auth_session_verifier")) return;
    setSubmitting(true);
    void completeWithNeon()
      .catch(err => setError(err instanceof Error ? err.message : "Sign-in could not be completed. Please try again."))
      .finally(() => setSubmitting(false));
    // Runs once on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Until everyone has moved to the new sign-in, people with an older password can still use it.
  const [oldWay, setOldWay] = useState(false);
  const useNeon = neon?.enabled === true && !oldWay;

  const finishSignIn = (session: TallySession) => {
    // A different account may have been in this browser; each sign-in starts with its own clients.
    localStorage.removeItem("finverify_active_client");
    // Remembered so signing out also ends the Neon sign-in.
    localStorage.setItem("finverify_neon", "1");
    login({ token: session.token, expiresAt: session.expiresAt, user: session.user });
    navigate(session.created ? "/onboarding" : nextRouteFor(session.user.email));
  };

  const completeWithNeon = async () => {
    const token = await neonToken();
    if (!token) throw new NeonAuthError("Sign-in could not be completed. Please try again.");
    finishSignIn(await exchangeForSession(token, companyName.trim() || undefined));
  };

  const askForCode = async (reason: "email-verification" | "forget-password") => {
    await neonSendCode(email, reason);
    setCode("");
    setInfo(`We emailed a 6-digit code to ${email}.`);
    setStep(reason === "forget-password" ? "reset" : "code");
  };

  const handleNeonSubmit = async () => {
    if (step === "code") {
      await neonVerifyEmail(email, code.trim());
      // Confirming the email normally signs the person in; if it did not, sign in now.
      if (!(await neonToken()) && password) await neonSignIn(email, password);
      await completeWithNeon();
      return;
    }
    if (step === "forgot") {
      await askForCode("forget-password");
      return;
    }
    if (step === "reset") {
      await neonResetPassword(email, code.trim(), newPassword);
      setPassword(newPassword);
      if (!(await neonSignIn(email, newPassword))) throw new NeonAuthError("Your password was changed. Please sign in.");
      await completeWithNeon();
      return;
    }
    if (mode === "register") {
      await neonSignUp(name, email, password);
      await askForCode("email-verification");
      return;
    }
    if (!(await neonSignIn(email, password))) {
      await askForCode("email-verification");
      return;
    }
    await completeWithNeon();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    if (useNeon) {
      try {
        await handleNeonSubmit();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Authentication failed");
      } finally {
        setSubmitting(false);
      }
      return;
    }

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
    if (useNeon) {
      setError("");
      neonSocialStart(provider, `${BASE}/login`).catch(err => setError(err instanceof Error ? err.message : "That sign-in could not be started."));
      return;
    }
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

          <h1 className="text-2xl font-bold mb-1">
            {step === "code" ? "Check your email" : step === "forgot" ? "Reset your password" : step === "reset" ? "Choose a new password" : isRegister ? "Create your free account" : "Welcome back"}
          </h1>
          <p className="text-muted-foreground text-sm mb-6">
            {step === "code" || step === "reset"
              ? info
              : step === "forgot"
                ? "Enter your email and we will send you a code."
                : isRegister ? "Takes under a minute. No card needed." : "Sign in to continue."}
          </p>

          {step === "form" && <div className="mb-6 grid grid-cols-2 rounded-xl border border-border bg-muted/40 p-1">
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
                  if (item.id === "register") setOldWay(false);
                }}
                className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                  mode === item.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>}

          {step === "form" && !oldWay && <><div className="mb-5 grid gap-3 sm:grid-cols-2">
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
          </div></>}

          <form onSubmit={handleSubmit} className="space-y-4">
            {step === "form" && (
              <>
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


                {useNeon && !isRegister && (
                  <button type="button" onClick={() => { setError(""); setStep("forgot"); }} className="text-xs font-medium text-muted-foreground hover:text-foreground">
                    Forgot your password?
                  </button>
                )}
              </>
            )}

            {step === "forgot" && (
              <div>
                <label className="text-sm font-medium mb-1.5 block">Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" className="w-full px-3 py-2.5 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors" required />
              </div>
            )}

            {(step === "code" || step === "reset") && (
              <div>
                <label className="text-sm font-medium mb-1.5 block">6-digit code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  className="w-full px-3 py-2.5 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors tracking-[0.4em]"
                  required
                />
              </div>
            )}

            {step === "reset" && (
              <div>
                <label className="text-sm font-medium mb-1.5 block">New password</label>
                <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="At least 8 characters" minLength={8} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors" required />
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <button
              type="submit"
              disabled={submitting || demoLoading}
              className="fv-brand-accent-bg w-full py-2.5 font-semibold rounded-lg transition-colors text-sm disabled:opacity-60"
            >
              {submitting ? "Working..." : step === "code" ? "Confirm and continue" : step === "forgot" ? "Send code" : step === "reset" ? "Change password" : isRegister ? "Create account" : "Sign in"}
            </button>

            {step !== "form" && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {(step === "code" || step === "reset") && (
                  <button type="button" disabled={submitting} className="text-muted-foreground hover:text-foreground" onClick={() => { setError(""); askForCode(step === "reset" ? "forget-password" : "email-verification").catch(err => setError(err instanceof Error ? err.message : "The code could not be sent.")); }}>
                    Send a new code
                  </button>
                )}
                <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => { setStep("form"); setError(""); setInfo(""); setCode(""); }}>
                  Back
                </button>
              </div>
            )}
          </form>

          {step === "form" && neon?.enabled && neon.legacyLogin && !isRegister && (
            <p className="mt-3 text-center text-xs text-muted-foreground">
              {oldWay ? (
                <>Signing in with your old password. <button type="button" className="font-semibold underline" onClick={() => { setOldWay(false); setError(""); }}>Use the new sign-in</button></>
              ) : (
                <>Signed up before this update? <button type="button" className="font-semibold underline" onClick={() => { setOldWay(true); setError(""); }}>Sign in with your old password</button></>
              )}
            </p>
          )}

          {step === "form" && <div className="mt-5 rounded-xl border border-border bg-card p-4">
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

          </div>}
        </motion.div>
      </div>
    </div>
  );
}
