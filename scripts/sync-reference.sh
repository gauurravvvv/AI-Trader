#!/usr/bin/env bash
# Re-vendor the reference repos into reference/, .git stripped.
#   ./scripts/sync-reference.sh            re-clone at the SHAs pinned in reference/MANIFEST.md
#   ./scripts/sync-reference.sh --latest   clone upstream HEAD and print new SHAs for the manifest
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="$ROOT/reference"
LATEST="${1:-}"

REPOS=(
  "TradingAgents|TauricResearch/TradingAgents|9dee508c44662702281a8dbaad1f7b42179b5ba7"
  "ai-hedge-fund|virattt/ai-hedge-fund|eff8a7320fcf0b473b135690fa1a5b0d9b022a83"
  "openalgo|marketcalls/openalgo|adbde8d4d550ba9b42158747ece3a2141a3147dc"
  "AgenticTrading|Open-Finance-Lab/AgenticTrading|43ab8e6ea09a5bd50bbbc6ec4fc5bad2a56ccf01"
  "InvestSkill|yennanliu/InvestSkill|22a285674ca2fdc9687eca90a62a0c94bbebefb2"
  "ai-trading-claude|zubair-trabzada/ai-trading-claude|c6d7252211a72405cefaff3e62d27a032c58348c"
)

mkdir -p "$REF"
for row in "${REPOS[@]}"; do
  IFS='|' read -r name slug sha <<< "$row"
  target="$REF/$name"
  rm -rf "${target:?}"
  if [ "$LATEST" = "--latest" ]; then
    git clone --depth 1 "https://github.com/$slug.git" "$target"
  else
    git clone --filter=blob:none --no-checkout "https://github.com/$slug.git" "$target"
    git -C "$target" checkout --detach "$sha"
  fi
  echo "$name -> $(git -C "$target" rev-parse HEAD)"
  # Stripped so the workspace stays a single self-contained git tree. Without
  # this, git records a gitlink (mode 160000) and a fresh clone gets an empty
  # directory with no way to fetch it.
  rm -rf "$target/.git"
done
echo "Done. If you used --latest, update the SHAs in reference/MANIFEST.md."
