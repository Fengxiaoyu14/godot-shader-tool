#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
validator_dir="$(cd "$script_dir/.." && pwd)"
repo_dir="$(cd "$validator_dir/.." && pwd)"
executable="${1:-$repo_dir/.opencode/tools/bin/windows-x64/godot-shader-validator.exe}"

for command in file x86_64-w64-mingw32-objdump; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required PE inspection command is unavailable: $command" >&2
    exit 1
  fi
done

file_description="$(file "$executable")"
if [[ "$file_description" != *"PE32+ executable (console) x86-64"* ]]; then
  echo "Unexpected Windows validator format: $file_description" >&2
  exit 1
fi

mapfile -t imports < <(
  x86_64-w64-mingw32-objdump -p "$executable" |
    awk '/DLL Name:/ { print tolower($3) }' |
    sort -u
)
if [[ "${#imports[@]}" -eq 0 ]]; then
  echo "No PE imports were found" >&2
  exit 1
fi

for imported_dll in "${imports[@]}"; do
  case "$imported_dll" in
    kernel32.dll|msvcrt.dll) ;;
    *)
      echo "Unexpected dynamically imported DLL: $imported_dll" >&2
      exit 1
      ;;
  esac
done

printf 'PE format: x86-64 console\n'
printf 'PE imports: %s\n' "${imports[*]}"
