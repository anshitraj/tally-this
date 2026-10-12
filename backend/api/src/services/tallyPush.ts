/**
 * Sends vouchers straight into a running TallyPrime.
 * TallyPrime answers XML requests over HTTP when "TallyPrime acts as: Server" is on
 * (F1 Help → Settings → Connectivity), usually on port 9000. The address is set by the
 * TALLY_URL environment variable, never by the browser, so this only reaches the Tally
 * on the TallyThis computer or its network.
 */

export const TALLY_URL = (process.env.TALLY_URL || "http://localhost:9000").replace(/\/+$/, "");

export interface TallyImportResult {
  created: number;
  altered: number;
  ignored: number;
  errors: number;
  exceptions: number;
  /** Tally's own error lines, as written by Tally. */
  messages: string[];
}

function unescapeXml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function postToTally(xml: string, timeoutMs: number) {
  const response = await fetch(TALLY_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body: xml,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Tally answered with HTTP ${response.status}.`);
  return response.text();
}

/** Tally answers an import with counts such as <CREATED>3</CREATED> and any <LINEERROR> lines. */
export function parseImportResponse(text: string): TallyImportResult {
  const count = (tag: string) => {
    const match = text.match(new RegExp(`<${tag}>\\s*(\\d+)\\s*</${tag}>`, "i"));
    return match ? Number(match[1]) : 0;
  };
  const messages = [...text.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)].map(match => unescapeXml(match[1].trim())).filter(Boolean);
  return {
    created: count("CREATED"),
    altered: count("ALTERED"),
    ignored: count("IGNORED"),
    errors: count("ERRORS"),
    exceptions: count("EXCEPTIONS"),
    messages,
  };
}

const COMPANY_LIST_REQUEST = `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>TallyThisOpenCompanies</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="TallyThisOpenCompanies" ISMODIFY="No">
            <TYPE>Company</TYPE>
            <FETCH>NAME</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

export function parseCompanyNames(text: string) {
  const names = [
    ...[...text.matchAll(/<COMPANY\b[^>]*\bNAME="([^"]+)"/gi)].map(match => match[1]),
    ...[...text.matchAll(/<COMPANY\b[^>]*>[\s\S]*?<NAME\b[^>]*>([^<]+)<\/NAME>/gi)].map(match => match[1]),
  ];
  return [...new Set(names.map(name => unescapeXml(name).trim()).filter(Boolean))];
}

function ledgerListRequest(company: string) {
  const escaped = company.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>TallyThisLedgers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${escaped}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="TallyThisLedgers" ISMODIFY="No">
            <TYPE>Ledger</TYPE>
            <FETCH>NAME, PARENT</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

export interface TallyLedger { name: string; parent: string }

export function parseLedgers(text: string): TallyLedger[] {
  const ledgers = new Map<string, TallyLedger>();
  for (const match of text.matchAll(/<LEDGER\b([^>]*)>([\s\S]*?)<\/LEDGER>/gi)) {
    const name = match[1].match(/\bNAME="([^"]+)"/i)?.[1] ?? match[2].match(/<NAME\b[^>]*>([^<]+)<\/NAME>/i)?.[1];
    const parent = match[2].match(/<PARENT\b[^>]*>([^<]*)<\/PARENT>/i)?.[1] ?? "";
    if (name) ledgers.set(unescapeXml(name).trim(), { name: unescapeXml(name).trim(), parent: unescapeXml(parent).trim() });
  }
  return [...ledgers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The ledgers that already exist in a Tally company, so rows can be mapped to them instead of new names. */
export async function tallyLedgers(company: string): Promise<TallyLedger[]> {
  return parseLedgers(await postToTally(ledgerListRequest(company), 20_000));
}

/** Is Tally answering, and which companies are open in it? */
export async function tallyStatus(): Promise<{ running: boolean; companies: string[]; message: string }> {
  try {
    const companies = parseCompanyNames(await postToTally(COMPANY_LIST_REQUEST, 8000));
    return {
      running: true,
      companies,
      message: companies.length > 0 ? "Connected to Tally." : "Tally is running, but no company is open. Open the company in Tally.",
    };
  } catch {
    return {
      running: false,
      companies: [],
      message: "Tally is not reachable. Open TallyPrime on this computer and turn on F1 Help → Settings → Connectivity → TallyPrime acts as: Server (port 9000).",
    };
  }
}

/**
 * Creates any missing ledgers, then the vouchers. Ledgers that already exist are expected to
 * come back as errors from the masters step and are not treated as a failure; only the
 * voucher step decides whether the entries reached Tally.
 */
export async function sendVouchersToTally(input: { mastersXml?: string; vouchersXml: string; expected: number }) {
  const masters = input.mastersXml ? parseImportResponse(await postToTally(input.mastersXml, 60_000)) : null;
  const vouchers = parseImportResponse(await postToTally(input.vouchersXml, 120_000));
  return {
    ok: vouchers.created === input.expected && vouchers.errors === 0 && vouchers.exceptions === 0,
    expected: input.expected,
    created: vouchers.created,
    failed: Math.max(0, input.expected - vouchers.created),
    ledgersCreated: masters?.created ?? 0,
    messages: vouchers.messages.slice(0, 10),
  };
}
