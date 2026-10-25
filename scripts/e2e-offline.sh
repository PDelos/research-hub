#!/usr/bin/env bash
# Offline end to end through the UI proxy: brief → charter (scoping answers) → approve → sweep → cards → ⭐ →
# knowledge-base note → search. No keys, no network (fake model, mock Jev, synthetic sources).
# Usage: scripts/e2e-offline.sh [port]   (needs the UI built: npm run build -w rh-client-browser)
set -euo pipefail
PORT="${1:-4899}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$(mktemp -d)"
LOG="$DATA/server.log"
cleanup() { [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null || true; rm -rf "$DATA"; }
trap cleanup EXIT
(cd "$ROOT" && RH_ENV_FILE=none RH_MODE=offline RH_DATA_DIR="$DATA/data" RH_PORT="$PORT" RH_KB_VIEWER=off \
  node --import tsx apps/rh-server/src/main.ts > "$LOG" 2>&1) &
PID=$!
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null && break; sleep 0.5; done
U="http://localhost:$PORT/ui/v1"
H=(-H "Origin: http://localhost:$PORT" -H "Sec-Fetch-Site: same-origin" -H "content-type: application/json")
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
wait_charter() { for _ in $(seq 1 80); do [ "$(curl -s "$U/charter" "${H[@]}" | j "(d.get('run') or {}).get('status')")" = "done" ] && return; sleep 0.25; done; echo "charter run did not finish"; exit 1; }
step() { printf '%-28s %s\n' "$1" "$2"; }

curl -s -X PUT "$U/brief" "${H[@]}" -d '{"brief":"# Protein language models\n\nContacts and structure from sequence."}' > /dev/null
wait_charter
curl -s "$U/charter" "${H[@]}" | j "json.dumps({'answers':[{'id':q['id'],'answer':'Clinical work is out of scope'} for q in d['questions'] if not q.get('answer')]})" > "$DATA/answers.json"
if grep -q '"id"' "$DATA/answers.json"; then
  curl -s -X POST "$U/charter/answers" "${H[@]}" -d @"$DATA/answers.json" > /dev/null; sleep 0.5; wait_charter
fi
step "charter approved" "v$(curl -s -X POST "$U/charter/approve" "${H[@]}" -d '{}' | j "d['approved']['version']")"
curl -s -X POST "$U/runs/sweep" "${H[@]}" -d '{}' > /dev/null
for _ in $(seq 1 120); do s=$(curl -s "$U/sweeps" "${H[@]}" | j "d[0]['status'] if d else 'none'"); [ "$s" != running ] && [ "$s" != none ] && break; sleep 0.5; done
step "sweep" "$s"
CARD=$(curl -s "$U/cards" "${H[@]}" | j "d['groups'][0]['cards'][0]['id']")
step "cards" "$(curl -s "$U/cards" "${H[@]}" | j "len(d['groups'][0]['cards'])")"
curl -s -X PUT "$U/cards/$CARD/judgment" "${H[@]}" -d '{"verdict":"star","reason":"Great foundation"}' > /dev/null
for _ in $(seq 1 80); do st=$(curl -s "$U/kb/papers" "${H[@]}" | j "d[0]['status'] if d else 'none'"); [ "$st" = done ] && break; sleep 0.25; done
step "starred paper ingested" "$st"
step "knowledge-base search hits" "$(curl -s "$U/kb/search?q=protein" "${H[@]}" | j "len(d)")"
step "errors in the server log" "$(grep -c '"level":"error"' "$LOG" || true)"
[ "$s" = completed ] && [ "$st" = done ] && ! grep -q '"level":"error"' "$LOG" && echo "PASS" || { echo "FAIL (log: $LOG)"; trap - EXIT; exit 1; }
