import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export { db };

export async function validateDatabaseConnection(): Promise<"ok" | "error"> {
  try {
    await db.execute(sql`select 1`);
    return "ok";
  } catch {
    return "error";
  }
}
