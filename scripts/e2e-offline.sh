#!/usr/bin/env bash
# Offline end to end through the UI proxy: brief → charter (scoping answers) → approve → sweep → cards → ⭐ →
# knowledge-base note → search; then plugins: disable and enable the Obsidian viewer, swap to the Library viewer,
# install the sample external plugin, restart, use its chat tool from the desk, and roll back. No keys, no network
# (fake model, mock Jev, synthetic sources).
# Usage: scripts/e2e-offline.sh [port]   (needs the UI built: npm run build -w rh-client-browser)
set -euo pipefail
PORT="${1:-4899}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$(mktemp -d)"
LOG="$DATA/server.log"
start() {
  (cd "$ROOT" && RH_ENV_FILE=none RH_MODE=offline RH_DATA_DIR="$DATA/data" RH_PORT="$PORT" RH_KB_VIEWER=off \
    exec node --import tsx apps/rh-server/src/main.ts >> "$LOG" 2>&1) &
  PID=$!
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null && return; sleep 0.5; done
  echo "the hub did not start (log: $LOG)"; exit 1
}
stop() { [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null || true; PID=; }
cleanup() { stop; rm -rf "$DATA"; }
trap cleanup EXIT
start
U="http://localhost:$PORT/ui/v1"
H=(-H "Origin: http://localhost:$PORT" -H "Sec-Fetch-Site: same-origin" -H "content-type: application/json")
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
wait_charter() { for _ in $(seq 1 80); do [ "$(curl -s "$U/charter" "${H[@]}" | j "(d.get('run') or {}).get('status')")" = "done" ] && return; sleep 0.25; done; echo "charter run did not finish"; exit 1; }
step() { printf '%-28s %s\n' "$1" "$2"; }
FAILED=0
expect() { step "$1" "$2"; [ "$2" = "$3" ] || { echo "  expected: $3"; FAILED=1; }; }

curl -s -X PUT "$U/brief" "${H[@]}" -d '{"brief":"# Protein language models\n\nContacts and structure from sequence."}' > /dev/null
wait_charter
curl -s "$U/charter" "${H[@]}" | j "json.dumps({'answers':[{'id':q['id'],'answer':'Clinical work is out of scope'} for q in d['questions'] if not q.get('answer')]})" > "$DATA/answers.json"
if grep -q '"id"' "$DATA/answers.json"; then
  curl -s -X POST "$U/charter/answers" "${H[@]}" -d @"$DATA/answers.json" > /dev/null; sleep 0.5; wait_charter
fi
step "charter approved" "v$(curl -s -X POST "$U/charter/approve" "${H[@]}" -d '{}' | j "d['approved']['version']")"
curl -s -X POST "$U/runs/sweep" "${H[@]}" -d '{}' > /dev/null
for _ in $(seq 1 120); do s=$(curl -s "$U/sweeps" "${H[@]}" | j "d[0]['status'] if d else 'none'"); [ "$s" != running ] && [ "$s" != none ] && break; sleep 0.5; done
expect "sweep" "$s" completed
CARD=$(curl -s "$U/cards" "${H[@]}" | j "d['groups'][0]['cards'][0]['id']")
step "cards" "$(curl -s "$U/cards" "${H[@]}" | j "len(d['groups'][0]['cards'])")"
curl -s -X PUT "$U/cards/$CARD/judgment" "${H[@]}" -d '{"verdict":"star","reason":"Great foundation"}' > /dev/null
for _ in $(seq 1 80); do st=$(curl -s "$U/kb/papers" "${H[@]}" | j "d[0]['status'] if d else 'none'"); [ "$st" = done ] && break; sleep 0.25; done
expect "starred paper ingested" "$st" done
step "knowledge-base search hits" "$(curl -s "$U/kb/search?q=protein" "${H[@]}" | j "len(d)")"

# Plugins (v1-0)
state() { curl -s "$U/plugins/$1" "${H[@]}" | j "d['state']"; }
toggle() { curl -s -X POST "$U/plugins/$1/$2" "${H[@]}" -d '{}' | j "d['state']"; }
viewer() { curl -s "$U/plugins/contributions" "${H[@]}" | j "(d['viewer']['active'] or {}).get('id')"; }
INIT=$(curl -s "$U/plugins/history?limit=500" "${H[@]}" | j "d[-1]['id']")
expect "viewer plugin (RH_KB_VIEWER=off)" "$(state rh.viewer-obsidian)" disabled
expect "viewer plugin enabled" "$(toggle rh.viewer-obsidian enable)" active
expect "active viewer" "$(viewer)" obsidian
curl -s -X PUT "$U/plugins/rh.kb/settings" "${H[@]}" -d '{"values":{"kb.viewer":"library"}}' > /dev/null
expect "viewer swapped" "$(viewer)" library
expect "viewer plugin disabled" "$(toggle rh.viewer-obsidian disable)" disabled
PLAN=$(curl -s -X POST "$U/plugins/install" "${H[@]}" -d "{\"source\":{\"folder\":\"$ROOT/apps/rh-server/tests/fixtures/plugins/acme.sample\"}}" | j "d['planId']")
expect "sample plugin installed" "$(curl -s -X POST "$U/plugins/install/$PLAN/approve" "${H[@]}" -d '{}' | j "d['state']")" active
stop
start
REPLY=$(curl -s -X POST "$U/chat" "${H[@]}" -d '{"content":"use sample_echo {\"text\": \"from the desk\"}","waitMs":20000}' | j "(d.get('answer') or {}).get('text')")
expect "plugin chat tool (desk)" "$REPLY" "echo from the desk"
expect "rolled back" "$(curl -s -X POST "$U/plugins/rollback" "${H[@]}" -d "{\"commit\":\"$INIT\"}" | j "[p['state'] for p in d['plugins'] if p['id'] == 'acme.sample'][0]")" disabled
expect "viewer after rollback" "$(viewer)" library
expect "errors in the server log" "$(grep -c '"level":"error"' "$LOG" || true)" 0
[ "$FAILED" = 0 ] && echo "PASS" || { echo "FAIL (log: $LOG)"; trap - EXIT; stop; exit 1; }
