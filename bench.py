"""Final latency benchmark — post all fixes."""
import urllib.request, urllib.error, json, time
import os, sys

BASE_TS = "http://localhost:8080"
BASE_GO = "http://localhost:8090"
BASE_PY = "http://localhost:8091"
TOKEN   = os.environ.get("TALLYTHIS_TOKEN", "")
if not TOKEN:
    sys.exit("Set TALLYTHIS_TOKEN to a current sign-in token for the local server first.")
AUTH    = {"Authorization": f"Bearer {TOKEN}"}

def req(url, auth=True, method="GET", data=None, hdrs=None):
    h = dict(AUTH) if auth else {}
    if hdrs:
        h.update(hdrs)
    try:
        t0 = time.perf_counter()
        r = urllib.request.Request(url, headers=h, data=data, method=method)
        with urllib.request.urlopen(r, timeout=12) as resp:
            ms = int((time.perf_counter()-t0)*1000)
            resp.read()
            return ms, resp.status
    except urllib.error.HTTPError as e:
        ms = int((time.perf_counter()-t0)*1000)
        return ms, e.code
    except Exception as e:
        return 9999, 0

print("\n=== LATENCY BENCHMARK (post-fix) ===\n")

print("HEALTH (unauthenticated):")
go_ms, s  = req(f"{BASE_GO}/api/health", auth=False)
print(f"  [{s}] {go_ms:5d}ms  Go /api/health")
ts_ms, s  = req(f"{BASE_TS}/api/health", auth=False)
print(f"  [{s}] {ts_ms:5d}ms  TS /api/health")
py_ms, s  = req(f"{BASE_PY}/health", auth=False)
print(f"  [{s}] {py_ms:5d}ms  Python /health")

print("\nAUTH ENDPOINTS (Go-proxy vs TS-direct):")
benchmarks = [
    ("overview",       "/api/overview"),
    ("uploads",        "/api/uploads"),
    ("transactions",   "/api/transactions"),
    ("reconciliation", "/api/reconciliation"),
    ("risks",          "/api/risks"),
]
print(f"  {'Endpoint':<20} {'Go':>7}  {'TS':>7}  Overhead  Verdict")
print(f"  {'-'*20} {'-'*7}  {'-'*7}  {'-'*8}  -------")
for name, path in benchmarks:
    g, gs = req(f"{BASE_GO}{path}")
    t, ts = req(f"{BASE_TS}{path}")
    if g < 9999 and t < 9999:
        ov = g - t
        v = "OK" if ov < 50 else ("WARN" if ov < 150 else "SLOW")
        print(f"  {name:<20} {g:>6}ms  {t:>6}ms  {ov:>+7}ms  {v}")
    else:
        print(f"  {name:<20} [{gs}]     [{ts}]   -  CHECK")

print("\nPYTHON CSV PARSE (warm request, 2nd call):")
with open("finverify_test_bank_statement_may_2026.csv","rb") as f:
    csv_data = f.read()
boundary = b"--FVBound123"
parts = (
    b"--" + boundary + b"\r\n"
    b'Content-Disposition: form-data; name="file"; filename="bank.csv"\r\n'
    b"Content-Type: text/csv\r\n\r\n"
    + csv_data + b"\r\n"
    b"--" + boundary + b"\r\n"
    b'Content-Disposition: form-data; name="source_type"\r\n\r\nbank\r\n'
    b"--" + boundary + b"--\r\n"
)
ct = f"multipart/form-data; boundary={boundary.decode()}"
for i in range(3):
    t0 = time.perf_counter()
    try:
        r2 = urllib.request.Request(f"{BASE_PY}/parse/csv", data=parts,
            headers={"Content-Type": ct}, method="POST")
        with urllib.request.urlopen(r2, timeout=15) as resp:
            ms = int((time.perf_counter()-t0)*1000)
            result = json.loads(resp.read())
        rows = result.get("rows", [])
        print(f"  Run {i+1}: [{resp.status}] {ms:5d}ms  {len(rows)} rows  fields_ok={bool(rows and rows[0].get('date') and rows[0].get('debit'))}")
    except Exception as e:
        print(f"  Run {i+1}: ERR {e}")

print("\nGO WORKFLOW/RUNS (JWT Bearer -> Go->Neon DB directly):")
g, s = req(f"{BASE_GO}/api/workflow/runs")
print(f"  [{s}] {g:5d}ms  GET /api/workflow/runs")

print("\nGO HEALTH (with DB ping):")
try:
    r3 = urllib.request.Request(f"{BASE_GO}/api/health")
    with urllib.request.urlopen(r3, timeout=10) as resp:
        health = json.loads(resp.read())
    print(f"  ok={health.get('ok')}  ts={health.get('typeScriptFallback')}  py={health.get('pythonWorker')}  db={health.get('database')}")
    lat = health.get("latencyMs", {})
    if lat:
        for svc, ms in lat.items():
            print(f"    {svc}: {ms}ms")
except Exception as e:
    print(f"  ERR: {e}")

print()
