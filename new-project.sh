#!/usr/bin/env bash
# Create a new Research Hub project: one research theme = one container, set up so it never interferes with the
# others on this machine. Usage:
#   ./new-project.sh <name> [--base DIR] [--obsidian]
# Creates DIR/<name>/ (default DIR: ./projects) with docker-compose.yml and .env: compose name rh-<name>, the next
# free port from 4850 in steps of 10, a sweep time 20 minutes after the latest existing project, fresh tokens.
# The project uses the light image (the Library shows the knowledge base); --obsidian uses the add-on image with
# the Obsidian viewer.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base="$repo/projects"
name=""
obsidian=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) base="$2"; shift 2 ;;
    --obsidian) obsidian=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) if [[ -z "$name" ]]; then name="$1"; shift; else echo "unexpected argument: $1" >&2; exit 2; fi ;;
  esac
done

if [[ ! "$name" =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]]; then
  echo "usage: $0 <name> [--base DIR] [--obsidian]   (name: 1-40 lowercase letters, digits or dashes)" >&2
  exit 2
fi
dir="$base/$name"
if [[ -e "$dir" ]]; then
  echo "error: $dir already exists" >&2
  exit 1
fi
mkdir -p "$base"

# Values already taken by other projects in this base folder.
setting() { grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true; }
used_ports=()
sweeps=()
for env in "$base"/*/.env; do
  [[ -f "$env" ]] || continue
  p="$(setting RH_PUBLISH_PORT "$env")"; [[ -n "$p" ]] && used_ports+=("$p")
  s="$(setting RH_SWEEP_TIME "$env")"; [[ -n "$s" ]] && sweeps+=("$s")
done

port_busy() {
  local p="$1"
  for u in "${used_ports[@]+"${used_ports[@]}"}"; do [[ "$u" == "$p" ]] && return 0; done
  (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null && return 0
  return 1
}
port=4850
while port_busy "$port"; do port=$((port + 10)); done

# Sweep time: 20 minutes after the latest existing project's, wrapping at midnight.
sweep="06:00"
if [[ ${#sweeps[@]} -gt 0 ]]; then
  latest=0
  for s in "${sweeps[@]}"; do
    m=$((10#${s%%:*} * 60 + 10#${s##*:}))
    (( m > latest )) && latest=$m
  done
  next=$(((latest + 20) % 1440))
  sweep="$(printf '%02d:%02d' $((next / 60)) $((next % 60)))"
fi

token() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

mkdir -p "$dir/data"
if (( obsidian )); then image=obsidian target=obsidian viewer=on; else image=latest target=lite viewer=off; fi
sed -e "s|__NAME__|$name|g" -e "s|__REPO__|$repo|g" -e "s|__IMAGE__|$image|g" -e "s|__TARGET__|$target|g" \
  "$repo/deploy/project-compose.yml" > "$dir/docker-compose.yml"
set_var() {  # set_var KEY VALUE FILE: replace the KEY= line, or append it
  if grep -qE "^$1=" "$3"; then sed -i "s|^$1=.*|$1=$2|" "$3"; else printf '%s=%s\n' "$1" "$2" >> "$3"; fi
}
cp "$repo/.env.example" "$dir/.env"
chmod 600 "$dir/.env"
set_var RH_PROJECT_NAME "$name" "$dir/.env"
set_var RH_PUBLISH_PORT "$port" "$dir/.env"
set_var RH_SWEEP_TIME "$sweep" "$dir/.env"
set_var RH_API_TOKEN "$(token)" "$dir/.env"
set_var RH_CLIENT_TOKEN "$(token)" "$dir/.env"
set_var RH_MCP_TOKEN "$(token)" "$dir/.env"
set_var RH_KB_VIEWER "$viewer" "$dir/.env"

cat <<MSG
Created project "$name" in $dir
  compose project  rh-$name
  port             $port
  daily sweep      $sweep
  image            research-hub:$image$( (( obsidian )) && echo " (with the Obsidian viewer)" || echo " (light; the Library shows the knowledge base)")
  data             $dir/data

Next:
  1. Put this project's OpenRouter key in $dir/.env (OPENROUTER_API_KEY=...);
     one key per project with a credit limit keeps budgets apart.
  2. cd $dir && docker compose up -d
  3. Open http://$name.localhost:$port
MSG
