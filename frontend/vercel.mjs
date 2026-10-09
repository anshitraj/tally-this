// Vercel evaluates this file at deployment time; it is not part of the browser bundle.
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
  };
}

export const config = createVercelConfig();
