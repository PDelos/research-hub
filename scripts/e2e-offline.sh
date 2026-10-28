#!/usr/bin/env bash
# Offline end to end through the UI proxy: brief → charter (scoping answers) → approve → sweep → cards → ⭐ →
# knowledge-base note → search; then plugins: disable and enable the Obsidian viewer, swap to the Library viewer,
# install the sample external plugin, restart, use its chat tool from the desk, and roll back. No keys, no network
# (fake model, mock Jev, synthetic sources).
# Usage: scripts/e2e-offline.sh [port]   (needs the UI built: npm run build -w rh-client-browser)
#        E2E_BUNDLE=1 scripts/e2e-offline.sh   runs the bundled server (npm run pack -w rh-server) with plain node
#        E2E_IMAGE=research-hub:lite scripts/e2e-offline.sh   runs the hub in a container of that image
set -euo pipefail
PORT="${1:-4899}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$(mktemp -d)"
LOG="$DATA/server.log"
if [ -n "${E2E_BUNDLE:-}" ]; then ENTRY=(apps/rh-server/dist/server.mjs); else ENTRY=(--import tsx apps/rh-server/src/main.ts); fi
FIXTURES="$ROOT/apps/rh-server/tests/fixtures/plugins"
CONTAINER="rh-e2e-$PORT"
start() {
  if [ -n "${E2E_IMAGE:-}" ]; then
    mkdir -p "$DATA/data" && chmod 777 "$DATA/data"
    docker run -d --name "$CONTAINER" -e RH_MODE=offline -e RH_KB_VIEWER=off -e RH_ALLOWED_HOSTS="localhost:$PORT" \
      -v "$DATA/data:/data" -v "$ROOT/apps/rh-server/tests/fixtures/plugins:/fixtures:ro" \
      -p "127.0.0.1:$PORT:4850" "$E2E_IMAGE" > /dev/null
    FIXTURES=/fixtures
  else
    (cd "$ROOT" && RH_ENV_FILE=none RH_MODE=offline RH_DATA_DIR="$DATA/data" RH_PORT="$PORT" RH_KB_VIEWER=off \
      exec node "${ENTRY[@]}" >> "$LOG" 2>&1) &
    PID=$!
  fi
  for _ in $(seq 1 90); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null && return; sleep 0.5; done
  echo "the hub did not start (log: $LOG)"
  [ -n "${E2E_IMAGE:-}" ] && docker logs "$CONTAINER" 2>&1 | tail -5
  exit 1
}
stop() {
  if [ -n "${E2E_IMAGE:-}" ]; then
    docker stop -t 10 "$CONTAINER" > /dev/null 2>&1 || true
    docker logs "$CONTAINER" >> "$LOG" 2>&1 || true
    docker rm -f "$CONTAINER" > /dev/null 2>&1 || true
  else
    [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null || true; PID=
  fi
}
cleanup() { stop; rm -rf "$DATA" 2>/dev/null || docker run --rm -v "$DATA:/d" debian:trixie-slim rm -rf /d/data > /dev/null 2>&1; rm -rf "$DATA"; }
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
expect "active viewer (Obsidian cannot run)" "$(viewer)" library
curl -s -X PUT "$U/plugins/rh.kb/settings" "${H[@]}" -d '{"values":{"kb.viewer":"library"}}' > /dev/null
expect "viewer swapped" "$(viewer)" library
expect "viewer plugin disabled" "$(toggle rh.viewer-obsidian disable)" disabled
PLAN=$(curl -s -X POST "$U/plugins/install" "${H[@]}" -d "{\"source\":{\"folder\":\"$FIXTURES/acme.sample\"}}" | j "d['planId']")
expect "sample plugin installed" "$(curl -s -X POST "$U/plugins/install/$PLAN/approve" "${H[@]}" -d '{}' | j "d['state']")" active
stop
start
REPLY=$(curl -s -X POST "$U/chat" "${H[@]}" -d '{"content":"use sample_echo {\"text\": \"from the desk\"}","waitMs":20000}' | j "(d.get('answer') or {}).get('text')")
expect "plugin chat tool (desk)" "$REPLY" "echo from the desk"
# The daily cycle (v1-1): a nightly run, a digest, a comment on it, and an undo of one change.
curl -s -X POST "$U/runs/nightly" "${H[@]}" -d '{}' > /dev/null
for _ in $(seq 1 40); do n=$(curl -s "$U/cycle" "${H[@]}" | j "1 if d['lastNightly'] else 0"); [ "$n" = 1 ] && break; sleep 0.25; done
expect "nightly run recorded" "$n" 1
curl -s -X POST "$U/runs/review" "${H[@]}" -d '{}' > /dev/null
for _ in $(seq 1 40); do DIG=$(curl -s "$U/digests" "${H[@]}" | j "d[0]['id'] if d else ''"); [ -n "$DIG" ] && break; sleep 0.25; done
expect "digest lists the sweep" "$(curl -s "$U/digests/$DIG" "${H[@]}" | j "len(d['cycle']['sweeps'])")" 1
expect "comment saved" "$(curl -s -X POST "$U/digests/$DIG/comments" "${H[@]}" -d '{"section":"judgments","text":"more methods papers"}' | j "d['section']")" judgments
SWAP=$(curl -s "$U/plugins/history?limit=500" "${H[@]}" | j "[h['id'] for h in d if h['message'] == 'configure rh.kb: kb.viewer'][0]")
curl -s -X POST "$U/plugins/undo" "${H[@]}" -d "{\"commit\":\"$SWAP\"}" > /dev/null
expect "undo of the viewer choice" "$(curl -s "$U/plugins/history" "${H[@]}" | j "d[0]['message']")" "undo: configure rh.kb: kb.viewer"
# The harness (v1-2): a replay of past sweeps and the Quality view.
expect "replay (one sweep: too little)" "$(curl -s -X POST "$U/harness/replay" "${H[@]}" -d '{"variant":{"cardsPerSweep":5}}' | j "d['report']['verdict']")" "not enough data"
expect "quality: sweeps over time" "$(curl -s "$U/harness/quality" "${H[@]}" | j "len(d['overTime'])")" 1
# Slots and attribution (v1-3).
expect "slots in the catalog" "$(curl -s "$U/slots" "${H[@]}" | j "len(d)")" 6
expect "core cannot be changed" "$(curl -s "$U/plugins" "${H[@]}" | j "[p['kind'] for p in d['plugins'] if p['id'] == 'rh.harness'][0]")" core
expect "attribution (offline sources)" "$(curl -s "$U/attribution" "${H[@]}" | j "sum(a['cards'] for a in d) > 0")" True
expect "rolled back" "$(curl -s -X POST "$U/plugins/rollback" "${H[@]}" -d "{\"commit\":\"$INIT\"}" | j "[p['state'] for p in d['plugins'] if p['id'] == 'acme.sample'][0]")" disabled
expect "viewer after rollback" "$(viewer)" library
[ -n "${E2E_IMAGE:-}" ] && docker logs "$CONTAINER" >> "$LOG" 2>&1
expect "errors in the server log" "$(grep -c '"level":"error"' "$LOG" || true)" 0
[ "$FAILED" = 0 ] && echo "PASS" || { echo "FAIL (log: $LOG)"; trap - EXIT; stop; exit 1; }
