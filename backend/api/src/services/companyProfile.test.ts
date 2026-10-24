import assert from "node:assert/strict";
import test from "node:test";
import { validateCompanyUpdate } from "./companyProfile";
import { LIVE_TALLY_OFF, liveTallyBlocked } from "./tallyTarget";

// 29ABCDE1234F1Z5 is the usual example but its check character is not valid; this one is.
const VALID_GSTIN = "27AAPFU0939F1ZV";

test("a valid profile is accepted and cleaned up", () => {
  const result = validateCompanyUpdate({
    name: "  Mehta & Associates ",
    gstin: ` ${VALID_GSTIN.toLowerCase()} `,
    pan: " aapfu0939f ",
    caEmail: " CA@Firm.IN ",
    financialYearStart: "april",
  });
  assert.deepEqual(result, {
    ok: true,
    update: { name: "Mehta & Associates", gstin: VALID_GSTIN, pan: "AAPFU0939F", caEmail: "ca@firm.in", financialYearStart: "April" },
  });
});

test("empty GSTIN, PAN and CA email clear the stored value", () => {
  assert.deepEqual(validateCompanyUpdate({ gstin: "", pan: null, caEmail: "  " }), { ok: true, update: { gstin: null, pan: null, caEmail: null } });
});

test("wrong values are refused with a message a person can act on", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ name: "" }, /company name/],
    [{ name: "x".repeat(161) }, /company name/],
    [{ name: "bad\nname" }, /company name/],
    [{ name: 5 }, /company name/],
    [{ gstin: "29ABCDE1234F1Z0" }, /GSTIN is not valid/],
    [{ gstin: "123" }, /GSTIN is not valid/],
    [{ gstin: 12345 }, /must be text/],
    [{ pan: "ABCDE12345" }, /PAN is not valid/],
    [{ pan: "ABC" }, /PAN is not valid/],
    [{ caEmail: "not-an-email" }, /email/],
    [{ caEmail: "a@b" }, /email/],
    [{ financialYearStart: "Smarch" }, /financial year/],
    [{ financialYearStart: null }, /financial year/],
  ];
  for (const [body, message] of cases) {
    const result = validateCompanyUpdate(body);
    assert.equal(result.ok, false, JSON.stringify(body));
    if (!result.ok) assert.match(result.error, message, JSON.stringify(body));
  }
});

test("only the stored fields can be changed, whatever else is sent", () => {
  const result = validateCompanyUpdate({ name: "Real Co", plan: "enterprise", planUntil: "2099-01-01", dataRetentionDays: 1, id: 7, currency: "USD", industry: "x" });
  assert.deepEqual(result, { ok: true, update: { name: "Real Co" } });
  assert.deepEqual(validateCompanyUpdate({ plan: "enterprise" }), { ok: false, error: "Nothing to save." });
  for (const body of [null, undefined, "x", 5, [], {}]) assert.equal(validateCompanyUpdate(body).ok, false);
});

test("direct sending to Tally is only offered where it can work", () => {
  assert.equal(liveTallyBlocked({}), null, "a developer machine or a self-hosted install next to Tally");
  assert.equal(liveTallyBlocked({ NODE_ENV: "production" }), LIVE_TALLY_OFF);
  assert.equal(liveTallyBlocked({ APP_ENV: "production" }), LIVE_TALLY_OFF);
  assert.equal(liveTallyBlocked({ APP_ENV: "production", TALLY_CONNECTOR_ENABLED: "true" }), null, "an administrator who runs everything on one network");
  assert.match(LIVE_TALLY_OFF, /download the Tally XML file/);
});
