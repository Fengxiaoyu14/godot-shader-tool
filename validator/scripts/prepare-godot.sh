#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
validator_dir="$(cd "$script_dir/.." && pwd)"
godot_source="${GODOT_SOURCE_DIR:-$validator_dir/.build/godot-3.6}"
godot_commit="de2f0f147c5b7eff2d0f6dbc35042a4173fd59be"
patch_file="$validator_dir/patches/godot-3.6-standalone-gles3.patch"

if [[ ! -d "$godot_source/.git" ]]; then
  if [[ -e "$godot_source" ]]; then
    echo "Refusing to replace non-Git path: $godot_source" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$godot_source")"
  git clone --branch 3.6-stable --single-branch https://github.com/godotengine/godot.git "$godot_source" >&2
fi

actual_commit="$(git -C "$godot_source" rev-parse HEAD)"
if [[ "$actual_commit" != "$godot_commit" ]]; then
  if [[ -n "$(git -C "$godot_source" status --porcelain)" ]]; then
    echo "Godot source has local changes and is not at the pinned commit: $godot_source" >&2
    exit 1
  fi
  git -C "$godot_source" fetch origin "$godot_commit" >&2
  git -C "$godot_source" checkout --detach "$godot_commit" >&2
fi

if git -C "$godot_source" apply --reverse --check "$patch_file" >/dev/null 2>&1; then
  :
elif git -C "$godot_source" apply --check "$patch_file" >/dev/null 2>&1; then
  git -C "$godot_source" apply "$patch_file"
else
  echo "Godot standalone patch is neither applicable nor already applied: $patch_file" >&2
  exit 1
fi

printf '%s\n' "$godot_source"
