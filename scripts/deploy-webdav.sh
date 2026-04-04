#!/usr/bin/env bash

set -euo pipefail

RCLONE_PARENT_REMOTE="puter-webdav:r58playz/Documents"
RCLONE_DIR_NAME="node-apis"
RCLONE_REMOTE="${RCLONE_PARENT_REMOTE}/${RCLONE_DIR_NAME}"

# Seconds to wait for Puter's WebDAV to make a freshly-created directory
# visible to subsequent PROPFIND/stat calls (eventual-consistency workaround).
PUTER_DIR_SETTLE_SECONDS="${PUTER_DIR_SETTLE_SECONDS:-5}"
MAX_SYNC_ATTEMPTS="${MAX_SYNC_ATTEMPTS:-3}"

# --- preflight -------------------------------------------------------------

for tool in pnpm rclone; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'error: %s is required\n' "$tool" >&2
    exit 1
  fi
done

if ! rclone listremotes | grep -Fxq "puter-webdav:"; then
  printf 'error: rclone remote %s is not configured\n' "puter-webdav" >&2
  exit 1
fi

# --- helpers ---------------------------------------------------------------

# True if the remote path exists (listing a missing dir errors out).
remote_dir_exists() {
  rclone lsf "$1" >/dev/null 2>&1
}

# Create a remote dir only if missing, then wait for Puter to make it visible.
# Never deletes an existing dir, so its UUID (and any Puter site binding) is
# preserved across deploys.
ensure_remote_dir() {
  local dir="$1"
  if remote_dir_exists "$dir"; then
    printf '==> Preserving existing remote dir: %s\n' "$dir"
    return 0
  fi
  printf '==> Creating remote dir: %s\n' "$dir"
  rclone mkdir "$dir"
  printf '==> Waiting %ss for Puter to make %s visible\n' "$PUTER_DIR_SETTLE_SECONDS" "$dir"
  sleep "$PUTER_DIR_SETTLE_SECONDS"
}

# --- build -----------------------------------------------------------------

printf '==> Building project\n'
pnpm build

# --- ensure the directory tree exists BEFORE syncing -----------------------
# We deliberately never `rclone purge`: deleting + recreating the dir gives it
# a new UUID (breaking any Puter site pointed at it) and triggers the
# "Parent path does not exist: 404" visibility race. `rclone sync` already
# removes stale files inside the dir, so contents still end up matching dist.

ensure_remote_dir "${RCLONE_REMOTE}"

# Pre-create every subdir present in dist so rclone never has to mkParentDir a
# brand-new dir mid-transfer (that's what races on Puter). find is pre-order,
# so parents settle before their children are created.
while IFS= read -r subdir; do
  [ -n "$subdir" ] || continue
  ensure_remote_dir "${RCLONE_REMOTE}/${subdir}"
done < <(cd dist && find . -mindepth 1 -type d -printf '%P\n')

# --- sync ------------------------------------------------------------------

printf '==> Syncing dist to %s\n' "${RCLONE_REMOTE}"
attempt=1
until time rclone sync "dist" "${RCLONE_REMOTE}" --size-only --fast-list -vv; do
  if [ "$attempt" -ge "$MAX_SYNC_ATTEMPTS" ]; then
    printf 'error: sync failed after %s attempts\n' "$MAX_SYNC_ATTEMPTS" >&2
    exit 1
  fi
  printf '==> Sync attempt %s failed; settling %ss and retrying\n' \
    "$attempt" "$PUTER_DIR_SETTLE_SECONDS"
  sleep "$PUTER_DIR_SETTLE_SECONDS"
  attempt=$((attempt + 1))
done

# --- force-refresh non-hashed root files -----------------------------------
# Vite content-hashes asset filenames, so changed assets always upload under a
# new name and `--size-only` is safe for them. The root files (index.html,
# favicon.svg) keep stable names, so a same-size content change would be
# skipped by --size-only. Force them with --ignore-times so the live site
# never serves stale HTML. --max-depth 1 keeps this to the root files only.
printf '==> Force-refreshing root files in %s\n' "${RCLONE_REMOTE}"
time rclone copy "dist" "${RCLONE_REMOTE}" --ignore-times --max-depth 1 --fast-list -vv

printf '==> Deploy complete: %s\n' "${RCLONE_REMOTE}"
printf '==> Point your Puter site at: %s\n' "${RCLONE_REMOTE#puter-webdav:}"
