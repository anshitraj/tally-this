import type { SVGProps } from "react";

/** Hat and glasses, kept as an outline to match the workspace icons. */
export function IncognitoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="m6 10 2-6 4 1 4-1 2 6M3 10h18" />
      <circle cx="6.5" cy="17" r="3.5" />
      <circle cx="17.5" cy="17" r="3.5" />
      <path d="M10 17a2 2 0 0 1 4 0" />
    </svg>
  );
}
