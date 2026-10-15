/** Shown for a moment while a page's code arrives. It keeps the shell steady instead of flashing. */
export default function AppLoading() {
  return (
    <div className="fv-standard-page" role="status" aria-label="Loading">
      <div className="fv-skeleton h-9 w-56" />
      <div className="fv-skeleton mt-3 h-4 w-80 max-w-full" />
      <div className="fv-skeleton mt-8 h-44" />
      <div className="fv-skeleton mt-4 h-28" />
    </div>
  );
}
