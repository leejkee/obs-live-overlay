cmake_minimum_required(VERSION 3.24)
# 必须在 project() 的编译器检测之前加载。调用方仍可显式指定其他工具链。
if(CMAKE_HOST_WIN32 AND NOT DEFINED CMAKE_TOOLCHAIN_FILE)
    set(CMAKE_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/../../cmake/toolchains/msvc-x64.cmake"
        CACHE FILEPATH "Native compiler toolchain")
endif()
project(smtc_native LANGUAGES CXX)

# 在普通 PowerShell / CMD 中，从仓库根目录执行：
# npm run configure:native（只配置，供 LSP 使用）
# npm run build:native
# Ninja 会生成供 clangd / CMake Tools 使用的 compile_commands.json。
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "SMTC requires Windows and MSVC or clang-cl.")
endif()

if(NOT CMAKE_JS_VERSION)
    message(FATAL_ERROR "Configure with the project-local CMake.js: npm run configure:native")
endif()
if(NOT NODE_ARCH STREQUAL "x64" OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "SMTC requires the x64 compiler environment and --arch x64.")
endif()

# CMake.js 管理完整 Node SDK（本模块使用 uv.h，不能只使用 node-api-headers）。
# 完整 SDK 模式仍需显式定位 npm 安装的 node-addon-api C++ 头文件。
find_program(NODE_EXECUTABLE NAMES node REQUIRED)
execute_process(
    COMMAND "${NODE_EXECUTABLE}" -p
        "require('path').dirname(require.resolve('node-addon-api'))"
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    OUTPUT_VARIABLE NODE_ADDON_API_DEFAULT
    OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY
)
file(TO_CMAKE_PATH "${NODE_ADDON_API_DEFAULT}" NODE_ADDON_API_DEFAULT)
set(NODE_ADDON_API_DIR "${NODE_ADDON_API_DEFAULT}" CACHE PATH "node-addon-api headers")
if(NOT EXISTS "${NODE_ADDON_API_DIR}/napi.h")
    message(FATAL_ERROR "napi.h not found; run npm install or set NODE_ADDON_API_DIR.")
endif()

# 核心实现位于 src/；顶层 addon.cpp 和 bridge.cpp 属于 Node 包装层。
# 文件布局稳定后，可以把此处替换为显式源文件列表。
file(GLOB_RECURSE SMTC_IMPL_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp")
set(SMTC_SOURCES ${SMTC_IMPL_SOURCES})
list(FILTER SMTC_SOURCES EXCLUDE REGEX "/addon\\.cpp$")
file(GLOB_RECURSE SMTC_HEADERS CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/include/*.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/include/*.hpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/*.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/*.hpp"
)

add_library(smtc_lib STATIC ${SMTC_SOURCES} ${SMTC_HEADERS})

target_compile_features(smtc_lib PUBLIC cxx_std_20)
set_target_properties(smtc_lib PROPERTIES CXX_EXTENSIONS OFF)
target_include_directories(smtc_lib
    PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include"
)
target_include_directories(smtc_lib SYSTEM PUBLIC
    ${CMAKE_JS_INC}
    "${NODE_ADDON_API_DIR}"
)
# MSVC / SDK 搜索路径由 toolchain 写入编译命令，也供 clangd 使用。
target_compile_definitions(smtc_lib PUBLIC
    NAPI_VERSION=8
    NAPI_CPP_EXCEPTIONS
    NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS
    USING_UV_SHARED=1
    USING_V8_SHARED=1
    WIN32_LEAN_AND_MEAN
    NOMINMAX
)
target_compile_options(smtc_lib PUBLIC /EHsc /permissive- /utf-8 /bigobj)
target_link_libraries(smtc_lib PUBLIC ${CMAKE_JS_LIB} windowsapp ole32)

# 支持 addon.cpp 留在根目录，或随后移动到 src/。
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/addon.cpp")
    set(SMTC_ADDON_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/addon.cpp")
else()
    set(SMTC_ADDON_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/src/addon.cpp")
endif()
add_library(smtc-addon MODULE "${SMTC_ADDON_SOURCE}" bridge.cpp ${CMAKE_JS_SRC})
target_link_libraries(smtc-addon PRIVATE smtc_lib)
# CMake.js 默认只给 SHARED target 设置此参数；这里的 MODULE 需显式设置。
target_link_options(smtc-addon PRIVATE /DELAYLOAD:node.exe)
target_link_libraries(smtc-addon PRIVATE delayimp)
target_compile_definitions(smtc-addon PRIVATE
    BUILDING_NODE_EXTENSION
    NODE_GYP_MODULE_NAME=smtc
)
set_target_properties(smtc-addon PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    OUTPUT_NAME "smtc-addon"
    CXX_EXTENSIONS OFF
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/$<CONFIG>"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/$<CONFIG>"
)

option(SMTC_BUILD_FIXTURE "Build the standalone media test player" OFF)
if(SMTC_BUILD_FIXTURE)
    add_executable(smtc_fixture "${CMAKE_CURRENT_SOURCE_DIR}/../../test/native/media-fixture.cpp")
    target_compile_features(smtc_fixture PRIVATE cxx_std_20)
    target_compile_definitions(smtc_fixture PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
    target_compile_options(smtc_fixture PRIVATE /EHsc /permissive- /utf-8)
    target_link_libraries(smtc_fixture PRIVATE windowsapp ole32)
    set_target_properties(smtc_fixture PROPERTIES
        CXX_EXTENSIONS OFF
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/$<CONFIG>"
    )
endif()
