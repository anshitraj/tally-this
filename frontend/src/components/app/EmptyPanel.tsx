import type { ReactNode } from "react";
import { useLocation } from "wouter";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

/**
 * The one empty (or "could not load") state. It always says what is missing and offers the
 * obvious next move, so no page ends in a sentence with nothing to press.
 */
export default function EmptyPanel({
  icon: Icon = Inbox,
  title,
  children,
  actions,
  className = "",
}: {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`fv-empty fv-reveal ${className}`.trim()}>
      <span className="fv-empty-icon" aria-hidden="true">
        <Icon size={22} />
      </span>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {actions && <div className="fv-empty-actions">{actions}</div>}
    </section>
  );
}

/**
 * An advanced page with nothing in it yet. It says where the data comes from and goes there with
 * one press, plus the everyday job that produces the same answer in a simpler way.
 */
export function NoDataYet({
  icon,
  title,
  children,
  job,
  bare = false,
}: {
  icon?: LucideIcon;
  title: string;
  children: ReactNode;
  job?: { label: string; href: string };
  /** Inside a table cell or card that already has its own frame. */
  bare?: boolean;
}) {
  const [, navigate] = useLocation();
  return (
    <EmptyPanel
      icon={icon}
      title={title}
      className={bare ? "!border-0 !bg-transparent !py-8" : ""}
      actions={
        <>
          <button type="button" className="fv-button-primary" onClick={() => navigate("/app/uploads")}>
            Open Upload center
          </button>
          {job && (
            <button type="button" className="fv-button-secondary" onClick={() => navigate(job.href)}>
              {job.label}
            </button>
          )}
        </>
      }
    >
      {children}
    </EmptyPanel>
  );
}
