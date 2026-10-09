import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";

function candidateEnvPaths(startDir: string): string[] {
  const paths: string[] = [];
  let current = path.resolve(startDir);

  while (true) {
    paths.push(path.join(current, ".env"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return paths;
}

for (const envPath of candidateEnvPaths(process.cwd())) {
  if (fs.existsSync(envPath)) {
    config({ path: envPath, quiet: true });
  }
}
