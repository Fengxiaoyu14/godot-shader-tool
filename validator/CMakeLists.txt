cmake_minimum_required(VERSION 3.16)
project(godot_shader_validator LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(GODOT_SOURCE_DIR "" CACHE PATH "Path to the patched Godot 3.6 source tree")
set(GODOT_CORE_LIBRARY "" CACHE FILEPATH "Path to the Godot 3.6 Core static library built by SCons")

if(NOT GODOT_SOURCE_DIR)
    message(FATAL_ERROR "GODOT_SOURCE_DIR must point to the patched Godot 3.6 source tree")
endif()
if(NOT GODOT_CORE_LIBRARY)
    message(FATAL_ERROR "GODOT_CORE_LIBRARY must point to the Godot 3.6 Core static library")
endif()

foreach(required_file
        core/string_name.h
        servers/visual/shader_language.cpp
        servers/visual/shader_types.cpp
        servers/visual/shader_mode_standalone.h)
    if(NOT EXISTS "${GODOT_SOURCE_DIR}/${required_file}")
        message(FATAL_ERROR "Missing patched Godot source: ${GODOT_SOURCE_DIR}/${required_file}")
    endif()
endforeach()

add_executable(godot-shader-validator
    src/main.cpp
    src/godot_stubs.cpp
    "${GODOT_SOURCE_DIR}/servers/visual/shader_language.cpp"
    "${GODOT_SOURCE_DIR}/servers/visual/shader_types.cpp"
)

target_include_directories(godot-shader-validator PRIVATE "${GODOT_SOURCE_DIR}")
target_compile_definitions(godot-shader-validator PRIVATE
    GODOT_SHADER_STANDALONE
    MINIZIP_ENABLED
    ZSTD_STATIC_LINKING_ONLY
)

if(WIN32)
    target_include_directories(godot-shader-validator PRIVATE "${GODOT_SOURCE_DIR}/platform/windows")
    target_compile_definitions(godot-shader-validator PRIVATE
        WINDOWS_ENABLED
        MINGW_ENABLED
        MINGW_HAS_SECURE_API=1
        WINVER=0x0601
        _WIN32_WINNT=0x0601
    )
else()
    target_include_directories(godot-shader-validator PRIVATE "${GODOT_SOURCE_DIR}/platform/server")
    target_compile_definitions(godot-shader-validator PRIVATE SERVER_ENABLED UNIX_ENABLED)
endif()

target_link_libraries(godot-shader-validator PRIVATE "${GODOT_CORE_LIBRARY}")

if(UNIX AND NOT APPLE)
    target_link_libraries(godot-shader-validator PRIVATE pthread dl)
endif()

if(MSVC)
    target_compile_options(godot-shader-validator PRIVATE /Gy /Gw)
    target_link_options(godot-shader-validator PRIVATE /OPT:REF /OPT:ICF)
else()
    target_compile_options(godot-shader-validator PRIVATE
        -Os
        -fno-exceptions
        -ffunction-sections
        -fdata-sections
    )
    target_link_options(godot-shader-validator PRIVATE -Wl,--gc-sections)
endif()

if(WIN32 AND MINGW)
    target_link_options(godot-shader-validator PRIVATE -static -static-libgcc -static-libstdc++)
endif()

if(WIN32)
    set_target_properties(godot-shader-validator PROPERTIES OUTPUT_NAME "godot-shader-validator")
else()
    set_target_properties(godot-shader-validator PROPERTIES OUTPUT_NAME "godot-shader-validator-native")
endif()
