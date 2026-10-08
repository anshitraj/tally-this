/**
 * Books are stored on one company id.
 * A founder request uses the signed-in company.
 * A CA may name a client with ?client=, ?clientId=, body.client / body.clientId,
 * or the X-Client-Company-Id header, and only when ca_client_links allows it.
 */
import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getCompanyId } from "../middleware/authz";

function rawValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(rawValues);
  if (value == null) return [];
  const text = String(value).trim();
  if (!text || text === "null" || text === "undefined") return [];
  return [text];
}

function requestedIds(req: Request): string[] {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const explicit = [
    ...rawValues(req.query.client),
    ...rawValues(req.query.clientId),
    ...rawValues(body.client),
    ...rawValues(body.clientId),
  ];
  if (explicit.length > 0) return explicit;
  return rawValues(req.get("x-client-company-id"));
}

export async function resolveBooksCompanyId(req: Request, res: Response): Promise<number | null> {
  const own = getCompanyId(req);
  const ids = [...new Set(requestedIds(req))];
  if (ids.length === 0) {
    req.booksCompanyId = own;
    return own;
  }
  if (ids.length > 1) {
    res.status(400).json({ ok: false, error: "invalid client id" });
    return null;
  }
  const clientId = Number(ids[0]);
  if (!Number.isInteger(clientId) || clientId <= 0) {
    res.status(400).json({ ok: false, error: "invalid client id" });
    return null;
  }
  if (clientId === own) {
    req.booksCompanyId = own;
    return own;
  }
  try {
    const link = await db.execute(sql`
      SELECT 1 FROM ca_client_links
      WHERE ca_user_id = ${req.auth!.userId}
        AND client_company_id = ${clientId}
        AND status = 'active'
      LIMIT 1
    `);
    if (!link.rows || link.rows.length === 0) {
      res.status(403).json({ ok: false, error: "Not authorised for this client" });
      return null;
    }
  } catch {
    res.status(403).json({ ok: false, error: "Not authorised for this client" });
    return null;
  }
  req.booksCompanyId = clientId;
  return clientId;
}

export async function attachBooksCompany(req: Request, res: Response, next: (err?: unknown) => void): Promise<void> {
  if (!req.auth) {
    next();
    return;
  }
  const companyId = await resolveBooksCompanyId(req, res);
  if (companyId == null) return;
  next();
}
