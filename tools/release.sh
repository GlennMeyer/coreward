#!/usr/bin/env bash
#
# Rotate the admin key and push, in that order.
#
#   npm run release            # rotate, commit, push to the current branch
#
# ## Why this is a local script and not a CI step
#
# The repository is public, which makes Actions logs public. A key generated in
# CI is printed into a log anybody can read — strictly worse than never
# rotating. The key has to be born on a machine only you control, which means
# rotation happens here, at push time, and the workflow only ever sees the hash.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Working tree is dirty. Commit or stash first — release only writes the key." >&2
  exit 1
fi

npm run --silent rotate-key

git add src/ui/adminKey.ts
git commit --quiet -m "Rotate the admin key

Generated locally and printed once. Only the hash is committed, so the
repository and the shipped bundle contain no way to recover the key. Every
browser unlocked with the previous key is revoked on its next load."
git push --quiet origin "$(git rev-parse --abbrev-ref HEAD)"

echo "Pushed. The key above is the only copy — the old one is dead."
