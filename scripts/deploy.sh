#!/usr/bin/env bash
#
# Build and deploy stemplusc.org.
#
# Two things this does that a one-line npm script could not:
#
#   1. Switches Node itself. Astro 6 needs >= 22.12 and .nvmrc pins it, but
#      npm scripts inherit whatever Node the shell happens to be on — so
#      `npm run deploy` on a fresh terminal fails at the build step every time.
#
#   2. Shows what `rsync --delete` would remove, and asks before removing it.
#      The sync mirrors dist/ onto the live server: anything there that is not
#      in the build is deleted. Usually that is nothing. When it is not
#      nothing, you want to see the list before it happens, not after.
#
# Usage:
#   npm run deploy          # prompts if anything would be deleted
#   npm run deploy -- --yes # no prompt; for non-interactive use
#
set -euo pipefail

REMOTE="stemplus@vda3300.is.cc:domains/stemplusc.org/public_html/"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=12

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ASSUME_YES=0
for arg in "$@"; do
  [ "$arg" = "--yes" ] || [ "$arg" = "-y" ] && ASSUME_YES=1
done

# ── Node ────────────────────────────────────────────────────────────────────
# nvm is a shell function, not a binary, so it has to be sourced. Missing nvm
# is not fatal — the version check below still catches an unusable Node.
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use >/dev/null 2>&1 || nvm install >/dev/null 2>&1 || true
fi

NODE_VERSION="$(node -v 2>/dev/null || echo 'none')"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed -n 's/^v\([0-9]*\)\..*/\1/p')"
NODE_MINOR="$(printf '%s' "$NODE_VERSION" | sed -n 's/^v[0-9]*\.\([0-9]*\)\..*/\1/p')"

if [ -z "$NODE_MAJOR" ] ||
   [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] ||
   { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  echo ""
  echo "Node $NODE_VERSION is too old — Astro 6 needs >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}."
  echo "Tried to switch using .nvmrc but could not."
  echo ""
  echo "  nvm install && nvm use     # then re-run"
  echo ""
  exit 1
fi
echo "Node $NODE_VERSION"

# ── Build ───────────────────────────────────────────────────────────────────
echo ""
echo "Building…"
npm run build

if [ ! -f dist/index.html ]; then
  echo ""
  echo "Build produced no dist/index.html — refusing to sync an empty directory"
  echo "over the live site."
  echo ""
  exit 1
fi

# ── Never publish internal docs ─────────────────────────────────────────────
# docs/ holds internal material — design specs, the redesign gameplan, a
# colour palette. It is tracked in git deliberately, but it is not site
# content and has no business on a public web server.
#
# It sits outside src/ and public/, so Astro does not copy it and this check
# should never fire. It exists for the day someone moves a document into
# public/ to "make it easy to link", which is the only realistic way an
# internal file reaches stemplusc.org/docs/.
#
# A refusal rather than an rsync --exclude, for two reasons: an exclude would
# hide the mistake and leave the build quietly wrong, and excluded paths are
# protected from --delete, so a stray docs/ already on the server would
# survive every future deploy instead of being cleaned up.
if [ -e dist/docs ]; then
  echo ""
  echo "Build output contains dist/docs — refusing to deploy."
  echo ""
  echo "docs/ is internal material and must never reach the live site."
  echo "Something under src/ or public/ is now emitting it; find and remove"
  echo "that, then deploy again."
  echo ""
  exit 1
fi

# ── Preview deletions ───────────────────────────────────────────────────────
echo ""
echo "Checking what would be removed from the server…"

# Capture the dry run's exit status separately. If the connection fails, an
# empty result must not be read as "nothing will be deleted" — that is a
# silent false all-clear immediately before a destructive sync.
DRY_OUT="$(rsync -az --delete --dry-run "dist/" "$REMOTE" 2>&1)" && DRY_RC=0 || DRY_RC=$?

if [ "$DRY_RC" -ne 0 ]; then
  echo ""
  echo "Could not reach the server to preview changes (rsync exit $DRY_RC):"
  printf '%s\n' "$DRY_OUT" | tail -5 | sed 's/^/    /'
  echo ""
  echo "Stopping rather than syncing blind — a --delete sync you cannot preview"
  echo "is not one you want to run. Check SSH access and try again."
  echo ""
  exit 1
fi

DELETIONS="$(printf '%s\n' "$DRY_OUT" | sed -n 's/^deleting //p' || true)"

if [ -n "$DELETIONS" ]; then
  COUNT="$(printf '%s\n' "$DELETIONS" | wc -l | tr -d ' ')"
  echo ""
  echo "This deploy will DELETE $COUNT file(s) from the live site:"
  printf '%s\n' "$DELETIONS" | sed 's/^/    /' | head -40
  [ "$COUNT" -gt 40 ] && echo "    … and $((COUNT - 40)) more"
  echo ""
  if [ "$ASSUME_YES" -eq 1 ]; then
    echo "--yes given; continuing."
  elif [ ! -t 0 ]; then
    echo "Not an interactive terminal and --yes was not given. Stopping."
    exit 1
  else
    printf "Continue? [y/N] "
    read -r reply
    case "$reply" in
      [yY]|[yY][eE][sS]) ;;
      *) echo "Cancelled — nothing was changed."; exit 1 ;;
    esac
  fi
else
  echo "  Nothing will be deleted."
fi

# ── Deploy ──────────────────────────────────────────────────────────────────
echo ""
echo "Deploying to $REMOTE"
rsync -avz --delete "dist/" "$REMOTE"

echo ""
echo "Done — https://stemplusc.org"
