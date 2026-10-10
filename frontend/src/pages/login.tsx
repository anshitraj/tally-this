import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { ArrowLeft, Database, Eye, EyeOff, Github, Loader2 } from "lucide-react";
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

type Mode = "signin" | "signup";
// "form" is the normal page; the others are the email-code steps when Neon Auth is on.
type Step = "form" | "code" | "forgot" | "reset";

const INPUT =
  "w-full h-11 px-3 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors";

function modeFromAddress(): Mode {
  const mode = new URLSearchParams(window.location.search).get("mode");
  return mode === "signup" || mode === "register" ? "signup" : "signin";
}

function appRoute() {
  // A file dropped on the home page before sign-in goes straight to its job.
  const job = peekPendingJob();
  return job ? `/app/jobs/${job}` : "/app/overview";
}

function nextRouteFor(email: string) {
  return localStorage.getItem(`finverify_onboarding_complete:${email}`) === "true" ? appRoute() : "/onboarding";
}

/** The older email/password sign-in, used when Neon Auth is off or for an older password. */
async function legacyPost(path: string, body: unknown, timeoutMs = AUTH_TIMEOUT_MS): Promise<TallySession> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error === "Invalid credentials" ? "That email and password do not match." : data?.error || "Sign-in failed. Please try again.");
    return data;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw new Error("This is taking longer than usual. Please try again in a moment.");
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-[18px] w-[18px]" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function ProviderButton({ icon, label, onClick, disabled }: { icon: ReactNode; label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-11 w-full items-center justify-center gap-3 rounded-lg border border-border bg-card px-4 text-sm font-semibold transition-colors hover:bg-muted/40 disabled:opacity-60"
    >
      {icon}
      {label}
    </button>
  );
}

export default function LoginPage() {
  const [, navigate] = useLocation();
  const [mode, setModeState] = useState<Mode>(modeFromAddress);
  const [step, setStep] = useState<Step>("form");
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [info, setInfo] = useState("");
  const [error, setError] = useState(() => (new URLSearchParams(window.location.search).get("error") ? "That sign-in could not be completed. Please try again." : ""));
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [config, setConfig] = useState<NeonConfig | null>(null);
  // Until everyone has moved to the new sign-in, people with an older password can still use it.
  const [oldWay, setOldWay] = useState(false);

  const isSignup = mode === "signup";
  const neonOn = config?.enabled === true && !oldWay;

  useEffect(() => {
    void loadNeonConfig().then(setConfig);
  }, []);

  // A person returning from Google or GitHub arrives here with a note from Neon in the address.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("neon_auth_session_verifier")) return;
    setBusy(true);
    void completeWithNeon()
      .catch(err => {
        setError(err instanceof Error ? err.message : "Sign-in could not be completed. Please try again.");
        // The note works once; drop it so a refresh starts clean.
        const url = new URL(window.location.href);
        url.searchParams.delete("neon_auth_session_verifier");
        window.history.replaceState(window.history.state, "", url.toString());
      })
      .finally(() => setBusy(false));
    // Runs once on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setMode = (next: Mode) => {
    setModeState(next);
    setStep("form");
    setError("");
    setInfo("");
    setOldWay(false);
    const url = new URL(window.location.href);
    if (next === "signup") url.searchParams.set("mode", "signup");
    else url.searchParams.delete("mode");
    window.history.replaceState(window.history.state, "", url.toString());
  };

  const finishSignIn = (session: TallySession, viaNeon: boolean) => {
    // A different account may have been in this browser; each sign-in starts with its own clients.
    localStorage.removeItem("finverify_active_client");
    // Remembered so signing out also ends the Neon sign-in.
    if (viaNeon) localStorage.setItem("finverify_neon", "1");
    login({ token: session.token, expiresAt: session.expiresAt, user: session.user });
    if (session.created) {
      navigate("/onboarding");
      return;
    }
    if (viaNeon) {
      // A returning person goes straight to work, on any device.
      localStorage.setItem(`finverify_onboarding_complete:${session.user.email}`, "true");
      navigate(appRoute());
      return;
    }
    navigate(nextRouteFor(session.user.email));
  };

  const completeWithNeon = async () => {
    const token = await neonToken();
    if (!token) throw new NeonAuthError("Sign-in could not be completed. Please try again.");
    finishSignIn(await exchangeForSession(token), true);
  };

  const askForCode = async (reason: "email-verification" | "forget-password") => {
    await neonSendCode(email, reason);
    setCode("");
    setInfo(`We sent a 6-digit code to ${email}.`);
    setStep(reason === "forget-password" ? "reset" : "code");
  };

  const submitWithNeon = async () => {
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
    if (isSignup) {
      // Name and firm are asked on the next screen, the same as after Google or GitHub.
      await neonSignUp(email.split("@")[0], email, password);
      await askForCode("email-verification");
      return;
    }
    if (!(await neonSignIn(email, password))) {
      await askForCode("email-verification");
      return;
    }
    await completeWithNeon();
  };

  const submitTheOldWay = async () => {
    const session = isSignup
      ? await legacyPost("/api/auth/register", { name, companyName, email, password })
      : await legacyPost("/api/auth/login", { email, password });
    finishSignIn({ ...session, created: isSignup }, false);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (neonOn) await submitWithNeon();
      else await submitTheOldWay();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const continueWith = (provider: "google" | "github") => {
    setError("");
    setBusy(true);
    // Neon sends the person to Google or GitHub and back to this page.
    neonSocialStart(provider, `${BASE}/login`).catch(err => {
      setError(err instanceof Error ? err.message : "That sign-in could not be started.");
      setBusy(false);
    });
  };

  const openSample = async () => {
    setError("");
    setDemoBusy(true);
    try {
      const session = await legacyPost("/api/auth/demo", { intent: "load_demo_workspace" }, DEMO_TIMEOUT_MS);
      localStorage.setItem(`finverify_onboarding_complete:${session.user.email}`, "true");
      finishSignIn(session, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The sample workspace could not be opened.");
    } finally {
      setDemoBusy(false);
    }
  };

  const backToForm = () => {
    setStep("form");
    setError("");
    setInfo("");
    setCode("");
  };

  const sendAnotherCode = () => {
    setError("");
    askForCode(step === "reset" ? "forget-password" : "email-verification").catch(err => setError(err instanceof Error ? err.message : "The code could not be sent."));
  };

  const heading =
    step === "code" ? "Check your email"
    : step === "forgot" ? "Reset your password"
    : step === "reset" ? "Choose a new password"
    : isSignup ? "Create your account"
    : "Sign in to TallyThis";
  const subheading =
    step === "code" || step === "reset" ? info
    : step === "forgot" ? "Enter your email and we will send you a code."
    : isSignup ? "Free to start. No card needed."
    : "Welcome back. Pick up where you left off.";
  const submitLabel =
    step === "code" ? "Confirm and continue"
    : step === "forgot" ? "Send code"
    : step === "reset" ? "Change password"
    : isSignup ? "Create account"
    : "Sign in";

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
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="fv-login-form-card">
          <button
            type="button"
            onClick={() => (step === "form" ? navigate("/") : backToForm())}
            className="mb-8 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {step === "form" ? "Back to home" : "Back"}
          </button>

          <div className="mb-8 lg:hidden"><BrandMark /></div>

          <h1 className="mb-1 text-2xl font-bold">{heading}</h1>
          <p className="mb-6 text-sm text-muted-foreground">{subheading}</p>

          {step === "form" && neonOn && (
            <>
              <div className="space-y-3">
                <ProviderButton icon={<GoogleMark />} label="Continue with Google" onClick={() => continueWith("google")} disabled={busy} />
                <ProviderButton icon={<Github className="h-[18px] w-[18px]" />} label="Continue with GitHub" onClick={() => continueWith("github")} disabled={busy} />
              </div>
              <div className="my-6 flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">or continue with email</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            </>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {step === "form" && (
              <>
                {!neonOn && isSignup && (
                  <>
                    <div>
                      <label htmlFor="name" className="mb-1.5 block text-sm font-medium">Your name</label>
                      <input id="name" name="name" autoComplete="name" value={name} onChange={e => setName(e.target.value)} placeholder="Aarav Sharma" className={INPUT} required />
                    </div>
                    <div>
                      <label htmlFor="company" className="mb-1.5 block text-sm font-medium">Firm or business name</label>
                      <input id="company" name="organization" autoComplete="organization" value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Mehta & Associates" className={INPUT} required />
                    </div>
                  </>
                )}
                <div>
                  <label htmlFor="email" className="mb-1.5 block text-sm font-medium">Email</label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    inputMode="email"
                    autoComplete={isSignup ? "email" : "username"}
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className={INPUT}
                    required
                  />
                </div>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label htmlFor="password" className="text-sm font-medium">Password</label>
                    {!isSignup && neonOn && (
                      <button type="button" onClick={() => { setError(""); setStep("forgot"); }} className="text-xs font-medium text-muted-foreground hover:text-foreground">
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      id="password"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete={isSignup ? "new-password" : "current-password"}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder={isSignup ? "At least 8 characters" : "Your password"}
                      minLength={isSignup ? 8 : undefined}
                      className={`${INPUT} pr-10`}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(value => !value)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </>
            )}

            {step === "forgot" && (
              <div>
                <label htmlFor="reset-email" className="mb-1.5 block text-sm font-medium">Email</label>
                <input id="reset-email" name="email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" className={INPUT} required />
              </div>
            )}

            {(step === "code" || step === "reset") && (
              <div>
                <label htmlFor="code" className="mb-1.5 block text-sm font-medium">6-digit code</label>
                <input
                  id="code"
                  name="one-time-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  className={`${INPUT} tracking-[0.4em]`}
                  required
                />
              </div>
            )}

            {step === "reset" && (
              <div>
                <label htmlFor="new-password" className="mb-1.5 block text-sm font-medium">New password</label>
                <input id="new-password" name="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="At least 8 characters" minLength={8} className={INPUT} required />
              </div>
            )}

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

            <button
              type="submit"
              disabled={busy || demoBusy}
              className="fv-brand-accent-bg flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? "Please wait…" : submitLabel}
            </button>

            {(step === "code" || step === "reset") && (
              <p className="text-center text-sm text-muted-foreground">
                No email? Check spam, or{" "}
                <button type="button" disabled={busy} onClick={sendAnotherCode} className="font-semibold text-foreground hover:underline">send a new code</button>.
              </p>
            )}
          </form>

          {step === "form" && (
            <>
              <p className="mt-6 text-center text-sm text-muted-foreground">
                {isSignup ? (
                  <>Already have an account? <button type="button" onClick={() => setMode("signin")} className="font-semibold text-foreground hover:underline">Sign in</button></>
                ) : (
                  <>New to TallyThis? <button type="button" onClick={() => setMode("signup")} className="font-semibold text-foreground hover:underline">Create an account</button></>
                )}
              </p>

              {!isSignup && config?.enabled && config.legacyLogin && (
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  {oldWay ? (
                    <>Using your old password. <button type="button" className="font-semibold underline" onClick={() => { setOldWay(false); setError(""); }}>Use the new sign-in</button></>
                  ) : (
                    <>Signed up before this update? <button type="button" className="font-semibold underline" onClick={() => { setOldWay(true); setError(""); }}>Sign in with your old password</button></>
                  )}
                </p>
              )}

              {config?.demo && (
                <div className="mt-6 rounded-xl border border-border bg-card p-4">
                  <div className="mb-3 flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Database className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Just looking around?</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">Open a sample workspace with example data. Nothing you do there touches a real account.</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={openSample}
                    disabled={busy || demoBusy}
                    className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-semibold transition-colors hover:bg-muted/50 disabled:opacity-60"
                  >
                    {demoBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
                    {demoBusy ? "Opening sample workspace…" : "Try the sample workspace"}
                  </button>
                </div>
              )}
            </>
          )}
        </motion.div>
      </div>
    </div>
  );
}
