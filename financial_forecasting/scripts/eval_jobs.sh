#!/usr/bin/env bash
# Validation evals for the jobs pipeline (SF bridge + jobs logic).
#
# These mock Salesforce + the DB so they run with no live org / no network —
# the same harness I use to build and validate jobs changes before pushing.
#
#   scripts/eval_jobs.sh            # run the jobs eval suite
#   scripts/eval_jobs.sh -k handoff # filter by name
#   scripts/eval_jobs.sh -v         # verbose (per-test names)
set -euo pipefail
cd "$(dirname "$0")/.."

# Jobs-related test modules. Add new jobs test files here as they're written.
TESTS=(
  tests/test_jobs_sf.py
)

echo "▶ jobs evals: ${TESTS[*]}"
python3 -m pytest "${TESTS[@]}" -p no:warnings -o addopts="" -q "$@"
