#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
validator_dir="$(cd "$script_dir/.." && pwd)"
repo_dir="$(cd "$validator_dir/.." && pwd)"
jobs="${VALIDATOR_JOBS:-1}"
godot_source="$($script_dir/prepare-godot.sh)"
build_dir="$validator_dir/.build/native"
core_library="$godot_source/core/libcore.x11.opt.64.shader_validator.a"
output_dir="$repo_dir/.opencode/tools/bin/linux-x64"

# A MinGW activation script may export this CMake environment variable. The
# native build must remain a host Linux build even when build-all.sh builds both.
unset CMAKE_TOOLCHAIN_FILE

for command in scons cmake ninja g++ strip; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required native build command is unavailable: $command" >&2
    exit 1
  fi
done

scons -C "$godot_source" -j"$jobs" \
  platform=server bits=64 tools=no target=release debug_symbols=no optimize=size lto=none \
  modules_enabled_by_default=no extra_suffix=shader_validator \
  CCFLAGS="-ffunction-sections -fdata-sections" \
  core/libcore.x11.opt.64.shader_validator.a

cmake -E remove_directory "$build_dir"
cmake -S "$validator_dir" -B "$build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_COMPILER="$(command -v g++)" \
  -DGODOT_SOURCE_DIR="$godot_source" \
  -DGODOT_CORE_LIBRARY="$core_library"
cmake --build "$build_dir"

mkdir -p "$output_dir"
cmake -E copy "$build_dir/godot-shader-validator-native" "$output_dir/godot-shader-validator"
strip "$output_dir/godot-shader-validator"
chmod +x "$output_dir/godot-shader-validator"
printf '%s\n' "$output_dir/godot-shader-validator"
