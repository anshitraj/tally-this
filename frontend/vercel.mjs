// Vercel evaluates this file at deployment time; it is not part of the browser bundle.

// Sent with every page and file. Vercel adds Strict-Transport-Security itself. A Content-Security-Policy is not set
// here: it has to name the sign-in provider's address, which is chosen at run time, so it needs its own testing.
export const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

export function createVercelConfig(backendOrigin = process.env.BACKEND_ORIGIN) {
  const rewrites = [];
  if (backendOrigin?.trim()) {
    const origin = new URL(backendOrigin.trim());
    if (origin.protocol !== "https:" || origin.username || origin.password ||
        origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error("BACKEND_ORIGIN must be an HTTPS origin without credentials, path, query or fragment");
    }
    rewrites.push({ source: "/api/:path*", destination: `${origin.origin}/api/:path*` });
  }
  rewrites.push(
    { source: "/login", destination: "/index.html" },
    { source: "/onboarding", destination: "/index.html" },
    { source: "/app", destination: "/index.html" },
    { source: "/app/:path*", destination: "/index.html" },
  );
  return {
    framework: "vite",
    installCommand: "pnpm install --frozen-lockfile",
    buildCommand: "pnpm run build",
    outputDirectory: "dist/public",
    rewrites,
    headers: [{ source: "/(.*)", headers: SECURITY_HEADERS }],
  };
}

export const config = createVercelConfig();
