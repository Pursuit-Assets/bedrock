#!/usr/bin/env bash
#
# pre-commit-guard.sh — refuses to commit any .env file.
#
# Installed into .git/hooks/pre-commit by scripts/install-git-hooks.sh.
#
# Logic:
#   1. List staged files (added, copied, or modified)
#   2. Filter for files matching .env or .env.<anything>
#      (allowing .env.example and .env.template)
#   3. If any matches, print a multi-line error and exit non-zero.
#
# To bypass (do this only if you're sure):  git commit --no-verify
#
set -euo pipefail

# Get all staged files (Added, Copied, Modified — not Deleted)
staged_files=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$staged_files" ]; then
    exit 0
fi

# Match anything ending in /.env, /.env.<word>, or starting with .env at repo root,
# but explicitly allow .env.example and .env.template (templates that should be tracked).
blocked=()
while IFS= read -r f; do
    # Get just the basename for the check
    base=$(basename "$f")
    case "$base" in
        .env)
            blocked+=("$f")
            ;;
        .env.example|.env.template)
            # Allowed templates
            ;;
        .env.*)
            blocked+=("$f")
            ;;
    esac
done <<< "$staged_files"

if [ ${#blocked[@]} -eq 0 ]; then
    exit 0
fi

cat >&2 <<EOF

╔══════════════════════════════════════════════════════════════════════════╗
║  COMMIT BLOCKED — refusing to commit .env file(s)                        ║
╚══════════════════════════════════════════════════════════════════════════╝

The following files were staged for commit but look like environment files:

EOF
for f in "${blocked[@]}"; do
    echo "    ${f}" >&2
done

cat >&2 <<'EOF'

These files typically contain credentials and should NEVER be committed.

To fix:
    git restore --staged <file>          # un-stage it
    Confirm the file is in .gitignore so this doesn't happen again

If you are absolutely certain you need to commit one of these (e.g. it's
actually a template file with no secrets), you can bypass this hook with:

    git commit --no-verify

But please double-check that there are no real credentials in the file
before doing so. If even one secret leaks into git history, it must be
treated as compromised and rotated immediately.

EOF

exit 1
