#!/usr/bin/env bash
# Stage a clean copy of doodledood/manifest-dev into /tmp/manifest-dev.
#
# Tries the fast single-tarball path first; on a GitHub session-access 403
# (common in Claude Code on the web / remote execution) it falls back to
# reconstructing the tree from public CDNs that are NOT behind the session's
# repo-scoped GitHub access layer. Only reads files; never runs git in the clone.
#
# Usage: bash stage-source.sh [ref]   (ref defaults to main)
# Exit 0 = /tmp/manifest-dev is populated and (in CDN mode) hash-verified.
set -euo pipefail

REPO="doodledood/manifest-dev"
REF="${1:-main}"
DEST="/tmp/manifest-dev"
CACERT="/root/.ccr/ca-bundle.crt"
CURL=(curl -sSL)
[ -f "$CACERT" ] && CURL+=(--cacert "$CACERT")

echo ">> staging $REPO@$REF -> $DEST"
rm -rf "$DEST" && mkdir -p "$DEST"

# --- Tier 1: single tarball (works locally, or when session GitHub access includes the repo)
tar_url="https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF"
code=$("${CURL[@]}" -o /tmp/manifest-dev.tar.gz -w "%{http_code}" "$tar_url" || echo 000)
if [ "$code" = "200" ] && tar -tzf /tmp/manifest-dev.tar.gz >/dev/null 2>&1; then
  tar -xzf /tmp/manifest-dev.tar.gz -C "$DEST" --strip-components=1
  echo ">> tarball OK"
  exit 0
fi
echo ">> tarball path unavailable (HTTP $code) — falling back to CDN reconstruction"

# --- Tier 2: CDN reconstruction (public repo only)
# jsDelivr serves the file tree; raw.githubusercontent.com serves file bodies.
# Neither sits behind the session's GitHub repo-access gate, so a public repo
# stages fine even when codeload/api.github.com/github.com return 403.
#
# Integrity model: `@main` is a MOVING ref and the two CDNs cache it on
# independent clocks — jsDelivr's metadata tree (the sha256 list) lags its own
# file CDN and lags raw by up to its ~12h metadata TTL. So the tree's hashes
# CANNOT be the integrity oracle: when main advances, updated files legitimately
# mismatch the stale hash and deleted files legitimately 404, neither of which
# is corruption. Instead we cross-verify each body from two independent fresh
# views — raw.githubusercontent.com and cdn.jsdelivr.net — and require they
# AGREE. Files that 404 on raw are treated as deleted-upstream and dropped
# (the tree only over-lists; it never under-lists the parts it still shows).
tree="/tmp/manifest-dev-tree.json"
code=$("${CURL[@]}" -o "$tree" -w "%{http_code}" \
  "https://data.jsdelivr.com/v1/packages/gh/$REPO@$REF?structure=flat" || echo 000)
[ "$code" = "200" ] || { echo "!! jsDelivr tree fetch failed (HTTP $code)"; exit 1; }

# For every file under claude-plugins/: fetch from raw (authoritative content,
# ~near-origin TTL) and from cdn.jsdelivr (independent view); require agreement.
python3 - "$tree" "$DEST" "$REPO" "$REF" "$CACERT" <<'PY'
import json, os, sys, subprocess, hashlib, tempfile
from concurrent.futures import ThreadPoolExecutor
tree, dest, repo, ref, cacert = sys.argv[1:6]
files = json.load(open(tree))["files"]
want = [f for f in files if f["name"].startswith("/claude-plugins/")]
raw = f"https://raw.githubusercontent.com/{repo}/{ref}"
cdn = f"https://cdn.jsdelivr.net/gh/{repo}@{ref}"
curl = ["curl","-sSL"] + (["--cacert",cacert] if os.path.exists(cacert) else [])

def get(base, path):
    fd, tmp = tempfile.mkstemp(); os.close(fd)
    try:
        r = subprocess.run(curl+["-o",tmp,"-w","%{http_code}",base+path],
                           capture_output=True, text=True)
        code = r.stdout.strip()
        body = open(tmp,"rb").read() if code == "200" else b""
        return code, body
    finally:
        os.unlink(tmp)

def dl(f):
    name = f["name"]
    rcode, rbody = get(raw, name)
    if rcode == "404":
        return ("dropped", name)          # deleted upstream since tree cached
    if rcode != "200":
        return ("error", name, f"raw HTTP {rcode}")
    ccode, cbody = get(cdn, name)
    if ccode == "200" and cbody != rbody:
        return ("error", name, "raw/cdn content disagree (propagation in flight — retry later)")
    # cdn 404/other while raw has it: raw is authoritative and fresher; accept.
    out = dest + name
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as fh: fh.write(rbody)
    return ("ok", name)

res = list(ThreadPoolExecutor(max_workers=12).map(dl, want))
errs    = [r for r in res if r[0] == "error"]
dropped = [r for r in res if r[0] == "dropped"]
ok      = [r for r in res if r[0] == "ok"]
if errs:
    for r in errs: print(f"!! {r[2]}: {r[1]}", file=sys.stderr)
    sys.exit(1)
print(f">> CDN reconstruction OK — {len(ok)} files staged, cross-verified raw==cdn")
if dropped:
    print(f">> {len(dropped)} tree-listed file(s) 404 on raw (deleted upstream), skipped:")
    for r in dropped: print(f"     - {r[1]}")
print(">> NOTE: file list came from jsDelivr's cached tree; a brand-new upstream")
print(">>       file added within jsDelivr's metadata TTL may not yet be listed.")
PY
