#!/usr/bin/env bash
set -euo pipefail

if [[ ! "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  printf '%s\n' 'Expected a deployment commit.' >&2
  exit 1
fi
target=${BASH_REMATCH[1]}
export GIT_TERMINAL_PROMPT=0

exec 9>"/run/lock/ttw-translation-deploy.lock"
flock -w 900 9
cd "/opt/translation-app"

if [[ $(git branch --show-current) != main || -n $(git status --porcelain) || ! -s .env.vps ]]; then
  printf '%s\n' 'Expected a clean main branch and a configured .env.vps in /opt/translation-app.' >&2
  exit 1
fi

git fetch origin main
if ! git merge-base --is-ancestor "$target" FETCH_HEAD; then
  printf '%s\n' 'The verified commit is not on origin/main.' >&2
  exit 1
fi

current=$(git rev-parse HEAD)
if [[ "$target" != "$current" ]] && git merge-base --is-ancestor "$target" "$current"; then
  printf 'Skipping older commit %s.\n' "$target"
  exit 0
fi
git merge --ff-only "$target"

bash deployment/prepare-vps.sh
docker compose --env-file .env.vps -f compose.vps.yaml up -d --build --wait --wait-timeout 180
docker compose --env-file .env.vps -f compose.vps.yaml exec -T api node -e '
  fetch("http://127.0.0.1:3000/ready")
    .then(async (response) => {
      if (!response.ok || (await response.json()).status !== "ready") throw new Error("API not ready");
      console.log("Translation API is ready");
    })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
'
printf 'Deployed verified commit %s.\n' "$target"
