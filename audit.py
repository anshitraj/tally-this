"""Authenticated full-system audit for FinVerify OS."""
import urllib.request, urllib.error, json, time, sys
import os

BASE_TS  = "http://localhost:8080"
BASE_GO  = "http://localhost:8090"
BASE_PY  = "http://localhost:8091"
TOKEN    = os.environ.get("TALLYTHIS_TOKEN", "")
if not TOKEN:
    sys.exit("Set TALLYTHIS_TOKEN to a current sign-in token for the local server first.")
AUTH     = {"Authorization": f"Bearer {TOKEN}"}

results = []

def req(label, url, method="GET", data=None, extra_headers=None, use_auth=True):
    headers = dict(AUTH) if use_auth else {}
    if extra_headers:
        headers.update(extra_headers)
    try:
        t0 = time.perf_counter()
        r = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(r, timeout=10) as resp:
            ms = int((time.perf_counter() - t0) * 1000)
            body = resp.read().decode("utf-8", errors="replace")
            status = resp.status
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"_raw": body[:80]}
        ok = "PASS" if status < 400 else "FAIL"
        results.append((label, status, ms, ok, parsed))
        icon = "[PASS]" if ok == "PASS" else "[FAIL]"
        print(f"  {icon} [{status}] {ms:5d}ms  {label}")
        return parsed, ms, status
    except urllib.error.HTTPError as e:
        ms = 9999
        body = ""
        try:
            body = e.read().decode()[:120]
        except Exception:
            pass
        results.append((label, e.code, ms, "FAIL", {}))
        print(f"  [FAIL] [{e.code}]  ERR     {label}  |  {body}")
        return None, ms, e.code
    except Exception as e:
        results.append((label, 0, 9999, "ERR", {}))
        print(f"  [ERR]  [---]  ERR     {label}  |  {e}")
        return None, 9999, 0


# ── SERVICE HEALTH ─────────────────────────────────────────────────────────
print("\n" + "="*64)
print("  1. SERVICE HEALTH")
print("="*64)
req("Go gateway /api/health",   f"{BASE_GO}/api/health",  use_auth=False)
req("TS API     /api/health",   f"{BASE_TS}/api/health",  use_auth=False)
req("Python     /health",       f"{BASE_PY}/health",      use_auth=False)

# ── LATENCY COMPARISON: Go vs TS (warm requests) ──────────────────────────
print("\n" + "="*64)
print("  2. LATENCY  Go-proxy vs direct-TS (warm, authenticated)")
print("="*64)
benchmarks = [
    ("overview",        "/api/overview"),
    ("uploads",         "/api/uploads"),
    ("transactions",    "/api/transactions"),
    ("reconciliation",  "/api/reconciliation"),
    ("risks",           "/api/risks"),
    ("payroll",         "/api/payroll"),
    ("exceptions",      "/api/exceptions"),
]
print(f"  {'Endpoint':<20}  {'Go':>7}  {'TS':>7}  {'Overhead':>10}  Status")
print(f"  {'-'*20}  {'-'*7}  {'-'*7}  {'-'*10}  ------")
for name, path in benchmarks:
    _, go_ms, go_code = req(f"go:{name}", f"{BASE_GO}{path}")
    _, ts_ms, ts_code = req(f"ts:{name}", f"{BASE_TS}{path}")
    if go_code < 400 and ts_code < 400:
        overhead = go_ms - ts_ms
        verdict = "OK" if overhead < 50 else ("WARN" if overhead < 150 else "SLOW")
        print(f"  {name:<20}  {go_ms:>6}ms  {ts_ms:>6}ms  {overhead:>+10}ms  {verdict}")
    else:
        print(f"  {name:<20}  [go:{go_code}]  [ts:{ts_code}]  -  CHECK")

# ── ALL TS API ENDPOINTS ───────────────────────────────────────────────────
print("\n" + "="*64)
print("  3. ALL TS API ENDPOINTS (authenticated)")
print("="*64)
endpoints = [
    # auth
    ("GET /api/auth/me",                    f"{BASE_TS}/api/auth/me"),
    ("GET /api/auth/providers",             f"{BASE_TS}/api/auth/providers",          False),
    # core
    ("GET /api/overview",                   f"{BASE_TS}/api/overview"),
    ("GET /api/uploads",                    f"{BASE_TS}/api/uploads"),
    ("GET /api/transactions",               f"{BASE_TS}/api/transactions"),
    ("GET /api/invoices",                   f"{BASE_TS}/api/invoices"),
    ("GET /api/ledger",                     f"{BASE_TS}/api/ledger"),
    ("GET /api/ledger-entries",             f"{BASE_TS}/api/ledger-entries"),
    ("GET /api/reconciliation",             f"{BASE_TS}/api/reconciliation"),
    ("GET /api/risks",                      f"{BASE_TS}/api/risks"),
    ("GET /api/payroll",                    f"{BASE_TS}/api/payroll"),
    ("GET /api/gateway-settlements",        f"{BASE_TS}/api/gateway-settlements"),
    # reports
    ("GET /api/reports/summary",            f"{BASE_TS}/api/reports/summary"),
    ("GET /api/ca-review",                  f"{BASE_TS}/api/ca-review"),
    # platform
    ("GET /api/company",                    f"{BASE_TS}/api/company"),
    ("GET /api/users",                      f"{BASE_TS}/api/users"),
    ("GET /api/roles",                      f"{BASE_TS}/api/roles"),
    ("GET /api/documents",                  f"{BASE_TS}/api/documents"),
    ("GET /api/audit-logs",                 f"{BASE_TS}/api/audit-logs"),
    ("GET /api/gst-records",                f"{BASE_TS}/api/gst-records"),
    # workflow / misc
    ("GET /api/monthly-close/current/workflow", f"{BASE_TS}/api/monthly-close/current/workflow"),
    ("GET /api/workflow/current-month",     f"{BASE_TS}/api/workflow/current-month"),
    ("GET /api/workflow/runs",              f"{BASE_TS}/api/workflow/runs"),
    ("GET /api/exceptions",                 f"{BASE_TS}/api/exceptions"),
    ("GET /api/action-history",             f"{BASE_TS}/api/action-history"),
    ("GET /api/ai/status",                  f"{BASE_TS}/api/ai/status"),
    ("GET /api/security/posture",           f"{BASE_TS}/api/security/posture"),
]
for item in endpoints:
    if len(item) == 3:
        label, url, use_auth = item
    else:
        label, url = item
        use_auth = True
    req(label, url, use_auth=use_auth)

# ── GO-NATIVE ENDPOINTS ────────────────────────────────────────────────────
print("\n" + "="*64)
print("  4. GO-NATIVE ENDPOINTS")
print("="*64)
req("GET /api/health (Go native)",          f"{BASE_GO}/api/health",                use_auth=False)
req("GET /api/workflow/runs (Go→DB)",       f"{BASE_GO}/api/workflow/runs")
req("GET /api/overview (Go→TS proxy)",      f"{BASE_GO}/api/overview")

# ── PYTHON WORKER DETAILED TEST ────────────────────────────────────────────
print("\n" + "="*64)
print("  5. PYTHON WORKER — parsing accuracy")
print("="*64)
req("GET /health",                          f"{BASE_PY}/health",                    use_auth=False)

print("\n  CSV parse (bank statement):")
with open("finverify_test_bank_statement_may_2026.csv","rb") as f:
    csv_data = f.read()
boundary = b"--FVBoundary12345"
parts = (
    b"--" + boundary + b"\r\n"
    b'Content-Disposition: form-data; name="file"; filename="bank.csv"\r\n'
    b"Content-Type: text/csv\r\n\r\n"
    + csv_data + b"\r\n"
    b"--" + boundary + b"\r\n"
    b'Content-Disposition: form-data; name="source_type"\r\n\r\n'
    b"bank\r\n"
    b"--" + boundary + b"--\r\n"
)
try:
    t0 = time.perf_counter()
    r = urllib.request.Request(f"{BASE_PY}/parse/csv",
        data=parts,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary.decode()}"},
        method="POST")
    with urllib.request.urlopen(r, timeout=15) as resp:
        ms = int((time.perf_counter()-t0)*1000)
        result = json.loads(resp.read())
    rows = result.get("rows", [])
    first = rows[0] if rows else {}
    required = ["date","debit","balance","narration"]
    missing = [k for k in required if not first.get(k)]
    all_ok = len(missing) == 0
    print(f"  [{'PASS' if all_ok else 'FAIL'}] [{resp.status}] {ms:5d}ms  {len(rows)} rows  {'All fields OK' if all_ok else 'MISSING: '+str(missing)}")
    for k in required:
        v = first.get(k)
        ok = "PASS" if v else "MISS"
        print(f"    [{ok}]  {k:<14} = {str(v)[:40]}")
except Exception as e:
    print(f"  [ERR] CSV parse: {e}")

print("\n  Tally CSV parse:")
with open("finverify_test_tally_ledger_may_2026.csv","rb") as f:
    tally_data = f.read()
parts2 = (
    b"--" + boundary + b"\r\n"
    b'Content-Disposition: form-data; name="file"; filename="tally.csv"\r\n'
    b"Content-Type: text/csv\r\n\r\n"
    + tally_data + b"\r\n"
    b"--" + boundary + b"\r\n"
    b'Content-Disposition: form-data; name="source_type"\r\n\r\n'
    b"tally\r\n"
    b"--" + boundary + b"--\r\n"
)
try:
    t0 = time.perf_counter()
    r = urllib.request.Request(f"{BASE_PY}/parse/csv",
        data=parts2,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary.decode()}"},
        method="POST")
    with urllib.request.urlopen(r, timeout=15) as resp:
        ms = int((time.perf_counter()-t0)*1000)
        result = json.loads(resp.read())
    rows = result.get("rows",[])
    first = rows[0] if rows else {}
    print(f"  [{'PASS' if rows else 'FAIL'}] {ms:5d}ms  {len(rows)} rows")
    print(f"    First row keys: {list(first.keys())[:8]}")
except Exception as e:
    print(f"  [ERR] Tally parse: {e}")

# ── SUMMARY ────────────────────────────────────────────────────────────────
print("\n" + "="*64)
print("  SUMMARY")
print("="*64)
total     = len(results)
passed    = sum(1 for r in results if r[3] == "PASS")
failed    = total - passed
avg_ms    = int(sum(r[2] for r in results if r[2] < 9999) / max(1, sum(1 for r in results if r[2] < 9999)))
failures  = [r for r in results if r[3] != "PASS"]

print(f"  Endpoints tested : {total}")
print(f"  Passed           : {passed}")
print(f"  Failed           : {failed}")
print(f"  Avg latency      : {avg_ms}ms")
if failures:
    print(f"\n  FAILURES:")
    for r in failures:
        print(f"    [{r[1]}] {r[0]}")
else:
    print(f"\n  No failures!")
print()
