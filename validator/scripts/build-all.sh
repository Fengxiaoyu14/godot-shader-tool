#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$script_dir/build-native.sh"
"$script_dir/test-native.sh"
"$script_dir/build-windows-x64.sh"
"$script_dir/inspect-windows.sh"
