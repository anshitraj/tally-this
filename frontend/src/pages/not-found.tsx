import { useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { BrandMark } from "@/components/app/finverify-ui";
import { getUser } from "@/lib/auth";
import { JOB_NAV } from "@/lib/navigation";

/** Shown for any address that is not a page. It always offers a way back and the four jobs. */
export default function NotFound({ inApp = false }: { inApp?: boolean; params?: unknown }) {
  const [location, navigate] = useLocation();
  const signedIn = Boolean(getUser());
  const home = signedIn ? "/app/overview" : "/";

  return (
    <main className="fv-notfound" style={inApp ? { minHeight: "70vh", background: "transparent" } : undefined}>
      {!inApp && <BrandMark />}
      <span className="fv-notfound-code">404</span>
      <h1>That page isn’t here.</h1>
      <p>
        <span className="break-all">{location}</span> does not match anything in TallyThis. It may have moved, or the link
        is mistyped.
      </p>
      <div className="fv-error-actions">
        <button type="button" className="fv-button-primary" onClick={() => navigate(home)}>
          <ArrowLeft className="h-4 w-4" />
          {signedIn ? "Back to your workspace" : "Back to home"}
        </button>
      </div>
      {signedIn && (
        <div className="fv-notfound-links" aria-label="Jobs">
          {JOB_NAV.map(job => {
            const Icon = job.icon;
            return (
              <button key={job.href} type="button" onClick={() => navigate(job.href)}>
                <Icon size={16} />
                {job.label}
              </button>
            );
          })}
        </div>
      )}
    </main>
  );
}
