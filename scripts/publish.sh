#!/usr/bin/env bash
# Publish docs/ to the gh-pages branch (what the website serves). Data files this job did not
# produce are carried over from the currently published site, so jobs do not erase each other.
set -euo pipefail
mkdir -p docs/data
git fetch -q --depth=1 origin gh-pages || true
for f in market.json read.json stats.json model.json journal.json; do
  if [ ! -f "docs/data/$f" ]; then
    git show "origin/gh-pages:data/$f" > "docs/data/$f" 2>/dev/null || rm -f "docs/data/$f"
  fi
done
tmp="$(mktemp -d)"
cp -r docs/. "$tmp"/
touch "$tmp/.nojekyll"
cd "$tmp"
git init -q -b gh-pages
git add -A
git -c user.name="site-bot" -c user.email="site-bot@users.noreply.github.com" commit -qm "publish $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q -f "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" gh-pages
echo "published"
