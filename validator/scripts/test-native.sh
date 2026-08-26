#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
validator_dir="$(cd "$script_dir/.." && pwd)"
repo_dir="$(cd "$validator_dir/.." && pwd)"
executable="${1:-$repo_dir/.opencode/tools/bin/linux-x64/godot-shader-validator}"

if ! command -v node >/dev/null 2>&1; then
  echo "Required test command is unavailable: node" >&2
  exit 1
fi

node "$validator_dir/tests/run-validator-tests.mjs" "$executable"
