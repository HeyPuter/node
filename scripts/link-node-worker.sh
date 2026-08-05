#!/usr/bin/env bash
#
# Puts node-worker where this project expects to find it.
#
# It is a `link:../node-worker` dependency — a sibling checkout, not a registry package.
# That is deliberate: the two are developed together, and node-worker's `dist/` is built
# rather than published, so there is no version of it to install. A git dependency would
# not work either; it has no `prepare` script, so npm/pnpm would install the sources and
# leave `dist/` empty.
#
# So: use the sibling when it is there, and clone it from GitHub when it is not. This is
# the second case, for a machine that has only this repo. CI does the same thing with
# actions/checkout — see .github/workflows/continuous.yml.
#
# An existing checkout is never touched. A local one is usually ahead of, or deliberately
# different from, what is on GitHub, and resetting someone's working tree is not something
# a setup script gets to do quietly.

set -euo pipefail

REPO="${NODE_WORKER_REPO:-https://github.com/heyputer/node-worker.git}"
REF="${NODE_WORKER_REF:-}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sibling="$(dirname "$here")/node-worker"

if [ -e "$sibling/package.json" ]; then
  printf '==> Using the node-worker checkout already at %s\n' "$sibling"
  exit 0
fi

printf '==> Cloning %s into %s\n' "$REPO" "$sibling"
# shellcheck disable=SC2086 # REF is deliberately unquoted-when-empty
git clone --depth=1 ${REF:+--branch "$REF"} "$REPO" "$sibling"

# Built here rather than left to whoever runs `pnpm build` next: without `dist/` the app's
# build fails on an unresolved import, which is a confusing way to find out that a
# dependency was only half set up.
printf '==> Building node-worker — the long part: emsdk, the Node source, and a wasm link\n'
cd "$sibling"
pnpm install --frozen-lockfile
pnpm build
