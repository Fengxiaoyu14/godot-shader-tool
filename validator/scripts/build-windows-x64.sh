#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
validator_dir="$(cd "$script_dir/.." && pwd)"
repo_dir="$(cd "$validator_dir/.." && pwd)"
jobs="${VALIDATOR_JOBS:-1}"
godot_source="$($script_dir/prepare-godot.sh)"
build_dir="$validator_dir/.build/windows-x64"
core_library="$godot_source/core/libcore.windows.opt.64.shader_validator.a"
output_dir="$repo_dir/.opencode/tools/bin/windows-x64"

for command in scons cmake ninja x86_64-w64-mingw32-gcc x86_64-w64-mingw32-g++ \
  x86_64-w64-mingw32-gcc-ar x86_64-w64-mingw32-gcc-ranlib x86_64-w64-mingw32-windres \
  x86_64-w64-mingw32-strip; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required Windows x64 build command is unavailable: $command" >&2
    exit 1
  fi
done

mingw_gcc="$(command -v x86_64-w64-mingw32-gcc)"
mingw_prefix="${mingw_gcc%gcc}"

scons -C "$godot_source" -j"$jobs" \
  platform=windows bits=64 tools=no target=release debug_symbols=no optimize=size lto=none \
  windows_subsystem=console modules_enabled_by_default=no extra_suffix=shader_validator \
  mingw_prefix_64="$mingw_prefix" CCFLAGS="-ffunction-sections -fdata-sections" \
  core/libcore.windows.opt.64.shader_validator.a

cmake -E remove_directory "$build_dir"
cmake -S "$validator_dir" -B "$build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$validator_dir/cmake/mingw-w64-x86_64.cmake" \
  -DGODOT_SOURCE_DIR="$godot_source" \
  -DGODOT_CORE_LIBRARY="$core_library"
cmake --build "$build_dir"

mkdir -p "$output_dir"
cmake -E copy "$build_dir/godot-shader-validator.exe" "$output_dir/godot-shader-validator.exe"
x86_64-w64-mingw32-strip "$output_dir/godot-shader-validator.exe"
printf '%s\n' "$output_dir/godot-shader-validator.exe"
