#!/bin/bash
# Full CA workflow smoke test against running API on :8090
set -u
API="http://localhost:8090"
TOKEN_FILE=/tmp/finverify_token

step() { echo ""; echo "=== $1 ==="; }

step "login (demo)"
TOKEN=$(curl -s --max-time 30 -X POST "$API/api/auth/demo" \
  -H "Content-Type: application/json" \
  -d '{"email":"demo-ca@finverify.local","name":"Demo CA","companyName":"FinVerify Demo Co"}' \
  | python -c "import sys,json;print(json.load(sys.stdin)['token'])")
echo "TOKEN len=${#TOKEN}"
echo "$TOKEN" > "$TOKEN_FILE"
AUTH="Authorization: Bearer $TOKEN"

step "upload bank statement"
BANK=$(curl -s --max-time 30 -X POST "$API/api/uploads" -H "$AUTH" \
  -F 'file=@bank.csv;type=text/csv' -F "sourceType=bank")
echo "$BANK"
BANK_ID=$(echo "$BANK" | python -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
echo "BANK_ID=$BANK_ID"

step "upload tally export"
TALLY=$(curl -s --max-time 30 -X POST "$API/api/uploads" -H "$AUTH" \
  -F 'file=@tally.csv;type=text/csv' -F "sourceType=tally")
echo "$TALLY"
TALLY_ID=$(echo "$TALLY" | python -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
echo "TALLY_ID=$TALLY_ID"

step "list uploads"
curl -s --max-time 30 -H "$AUTH" "$API/api/uploads" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(len(d),'uploads');[print(u['id'],u['sourceType'],u['fileName'],u['status'],u.get('recordCount')) for u in d[:8]]"

step "GET upload details for bank"
curl -s --max-time 30 -H "$AUTH" "$API/api/uploads/$BANK_ID/details" \
  | python -c "import sys,json;d=json.load(sys.stdin);print('source',d['sourceType'],'rows',d['recordCount'],'doc rows',d.get('document',{}).get('rowCount') if d.get('document') else None)"

step "import selected sources (bank+tally)"
curl -s --max-time 30 -X POST "$API/api/uploads/import-selected-sources" -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"sourceTypes":["bank","tally"]}' \
  | python -m json.tool | head -20

step "monthly close workflow"
curl -s --max-time 30 -H "$AUTH" "$API/api/monthly-close/current/workflow" \
  | python -c "import sys,json;d=json.load(sys.stdin);print('recommended',d.get('recommendedRecipeId'),'recipes',[r['id'] for r in d['availableRecipes']])"

step "reconciliation preflight (BANK_TALLY)"
curl -s --max-time 30 -X POST "$API/api/reconciliation/preflight" -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"recipeId":"BANK_TALLY_RECONCILIATION"}' \
  | python -m json.tool | head -25

step "run reconciliation"
curl -s --max-time 60 -X POST "$API/api/reconciliation/run" -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"recipeId":"BANK_TALLY_RECONCILIATION"}' \
  | python -m json.tool

step "list matches"
MATCHES=$(curl -s --max-time 30 -H "$AUTH" "$API/api/reconciliation")
echo "$MATCHES" | python -c "import sys,json;d=json.load(sys.stdin);print(len(d),'matches');[print(m['id'],m['matchType'],'conf',m['confidenceScore'],'status',m['status']) for m in d[:6]]"
M1=$(echo "$MATCHES" | python -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')")
M2=$(echo "$MATCHES" | python -c "import sys,json;d=json.load(sys.stdin);print(d[1]['id'] if len(d)>1 else '')")
M3=$(echo "$MATCHES" | python -c "import sys,json;d=json.load(sys.stdin);print(d[2]['id'] if len(d)>2 else '')")
M4=$(echo "$MATCHES" | python -c "import sys,json;d=json.load(sys.stdin);print(d[3]['id'] if len(d)>3 else '')")
echo "review targets: approve=$M1 reject=$M2 needs-info=$M3 send-to-ca=$M4"

if [ -n "$M1" ]; then
  step "approve match $M1"
  curl -s -X POST "$API/api/reconciliation/$M1/approve" -H "$AUTH" | python -c "import sys,json;d=json.load(sys.stdin);print('new status:',d.get('status'))"
fi
if [ -n "$M2" ]; then
  step "reject match $M2"
  curl -s -X POST "$API/api/reconciliation/$M2/reject" -H "$AUTH" | python -c "import sys,json;d=json.load(sys.stdin);print('new status:',d.get('status'))"
fi
if [ -n "$M3" ]; then
  step "needs-info match $M3"
  curl -s -X POST "$API/api/reconciliation/$M3/needs-info" -H "$AUTH" | python -c "import sys,json;d=json.load(sys.stdin);print('new status:',d.get('status'))"
fi
if [ -n "$M4" ]; then
  step "send to CA review match $M4"
  curl -s -X POST "$API/api/reconciliation/$M4/send-to-ca" -H "$AUTH" -H "Content-Type: application/json" -d '{"note":"please verify counterparty name match"}' \
    | python -m json.tool
fi

step "finalize reconciliation"
curl -s -X POST "$API/api/reconciliation/finalize" -H "$AUTH" \
  | python -m json.tool

step "export CA-ready pack (JSON)"
curl -s --max-time 60 -X POST "$API/api/reports/export-ca-pack" -H "$AUTH" \
  | python -c "import sys,json;d=json.load(sys.stdin);print('canExport',d.get('canExport'),'blockers',d.get('blockers'),'summary',d.get('summary'))"

step "action history"
curl -s -H "$AUTH" "$API/api/action-history?limit=10" \
  | python -c "import sys,json;d=json.load(sys.stdin);[print(i.get('label'),'-',i.get('description')[:80]) for i in d[:10]]"

step "delete bank upload (force cascade)"
curl -s -X DELETE "$API/api/uploads/$BANK_ID?force=true" -H "$AUTH" \
  | python -m json.tool

step "list uploads after delete"
curl -s -H "$AUTH" "$API/api/uploads" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(len(d),'remaining');[print(u['id'],u['sourceType'],u['fileName'],u['status']) for u in d[:8]]"

echo ""
echo "=== DONE ==="
