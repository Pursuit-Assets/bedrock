#!/usr/bin/env bash
#
# install-git-hooks.sh — install repo-local git hooks.
#
# Idempotent. Safe to re-run after pulling new hook updates.
#
# Currently installs:
#   - pre-commit: blocks committing .env files (see scripts/pre-commit-guard.sh)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="${REPO_ROOT}/.git/hooks"
SOURCE_HOOK="${REPO_ROOT}/scripts/pre-commit-guard.sh"
TARGET_HOOK="${HOOKS_DIR}/pre-commit"

if [ ! -d "${HOOKS_DIR}" ]; then
    echo "ERROR: ${HOOKS_DIR} does not exist. Are you running this from inside a git checkout?" >&2
    exit 1
fi

if [ ! -f "${SOURCE_HOOK}" ]; then
    echo "ERROR: ${SOURCE_HOOK} not found." >&2
    exit 1
fi

# Copy (not symlink) so the hook works even if scripts/ is moved or renamed
cp "${SOURCE_HOOK}" "${TARGET_HOOK}"
chmod +x "${TARGET_HOOK}"

echo "Installed pre-commit hook → ${TARGET_HOOK}"
echo "    Source: ${SOURCE_HOOK}"
echo "    Now any 'git commit' that includes a .env file will be blocked."
echo "    To bypass (carefully): git commit --no-verify"
