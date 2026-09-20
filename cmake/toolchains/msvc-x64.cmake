# 普通终端中的 Windows x64 / MSVC / Ninja 工具链，不执行 vcvars。
# 工具和搜索路径写入构建规则，因此后续构建及 clangd 不依赖 configure 的环境。
include_guard(GLOBAL)
if(NOT CMAKE_HOST_WIN32)
    message(FATAL_ERROR "This toolchain requires a Windows host.")
endif()

set(SMTC_VS_ROOT "" CACHE PATH "Visual Studio installation; empty selects the latest installed instance")
set(WINSDK_ROOT "" CACHE PATH "Windows SDK root; empty detects the installed SDK")
set(WINSDK_VERSION "" CACHE STRING "Windows SDK version; empty selects the latest complete SDK")
list(APPEND CMAKE_TRY_COMPILE_PLATFORM_VARIABLES SMTC_VS_ROOT WINSDK_ROOT WINSDK_VERSION)

if(SMTC_VS_ROOT)
    set(_smtc_vs "${SMTC_VS_ROOT}")
else()
    find_program(_smtc_vswhere NAMES vswhere.exe
        HINTS "$ENV{ProgramFiles\(x86\)}/Microsoft Visual Studio/Installer"
        REQUIRED)
    execute_process(
        COMMAND "${_smtc_vswhere}" -latest -products * -utf8
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64
            -property installationPath
        OUTPUT_VARIABLE _smtc_vs OUTPUT_STRIP_TRAILING_WHITESPACE
        COMMAND_ERROR_IS_FATAL ANY)
endif()
if(NOT EXISTS "${_smtc_vs}/VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt")
    message(FATAL_ERROR "MSVC x64 tools not found. Install the Visual Studio C++ workload or set SMTC_VS_ROOT.")
endif()
file(TO_CMAKE_PATH "${_smtc_vs}" _smtc_vs)
file(STRINGS "${_smtc_vs}/VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt"
    _smtc_vc_version LIMIT_COUNT 1)
string(STRIP "${_smtc_vc_version}" _smtc_vc_version)
set(_smtc_vc "${_smtc_vs}/VC/Tools/MSVC/${_smtc_vc_version}")
set(_smtc_bin "${_smtc_vc}/bin/Hostx64/x64")

if(WINSDK_ROOT)
    set(_smtc_kits "${WINSDK_ROOT}")
else()
    cmake_host_system_information(RESULT _smtc_kits QUERY WINDOWS_REGISTRY
        "HKLM/SOFTWARE/Microsoft/Windows Kits/Installed Roots"
        VALUE KitsRoot10 VIEW 64 ERROR_VARIABLE _smtc_registry_error)
    if(_smtc_registry_error OR NOT _smtc_kits)
        set(_smtc_kits "$ENV{ProgramFiles\(x86\)}/Windows Kits/10")
    endif()
endif()
file(TO_CMAKE_PATH "${_smtc_kits}" _smtc_kits)
if(WINSDK_VERSION)
    set(_smtc_versions "${WINSDK_VERSION}")
else()
    file(GLOB _smtc_versions RELATIVE "${_smtc_kits}/Include" "${_smtc_kits}/Include/10.*")
    list(SORT _smtc_versions COMPARE NATURAL ORDER DESCENDING)
endif()
set(_smtc_sdk "")
foreach(_smtc_version IN LISTS _smtc_versions)
    set(_smtc_complete TRUE)
    foreach(_smtc_file IN ITEMS
        "Include/${_smtc_version}/ucrt/stdio.h"
        "Include/${_smtc_version}/um/windows.h"
        "Include/${_smtc_version}/shared/sdkddkver.h"
        "Include/${_smtc_version}/cppwinrt/winrt/base.h"
        "Lib/${_smtc_version}/ucrt/x64/ucrt.lib"
        "Lib/${_smtc_version}/um/x64/kernel32.lib"
        "Lib/${_smtc_version}/um/x64/windowsapp.lib"
        "bin/${_smtc_version}/x64/rc.exe"
        "bin/${_smtc_version}/x64/mt.exe")
        if(NOT EXISTS "${_smtc_kits}/${_smtc_file}")
            set(_smtc_complete FALSE)
            break()
        endif()
    endforeach()
    if(_smtc_complete)
        set(_smtc_sdk "${_smtc_version}")
        break()
    endif()
endforeach()
if(NOT _smtc_sdk)
    message(FATAL_ERROR "A complete Windows SDK with C++/WinRT and x64 libraries is required. Check WINSDK_ROOT / WINSDK_VERSION.")
endif()
set(_smtc_sdk_bin "${_smtc_kits}/bin/${_smtc_sdk}/x64")

set(CMAKE_C_COMPILER "${_smtc_bin}/cl.exe")
set(CMAKE_CXX_COMPILER "${_smtc_bin}/cl.exe")
set(CMAKE_LINKER "${_smtc_bin}/link.exe")
set(CMAKE_AR "${_smtc_bin}/lib.exe")
set(CMAKE_RC_COMPILER "${_smtc_sdk_bin}/rc.exe")
set(CMAKE_MT "${_smtc_sdk_bin}/mt.exe")
foreach(_smtc_tool IN ITEMS CMAKE_C_COMPILER CMAKE_LINKER CMAKE_AR CMAKE_RC_COMPILER CMAKE_MT)
    if(NOT EXISTS "${${_smtc_tool}}")
        message(FATAL_ERROR "Missing tool: ${${_smtc_tool}}")
    endif()
endforeach()
if(CMAKE_GENERATOR MATCHES "^Ninja" AND NOT CMAKE_MAKE_PROGRAM)
    find_program(CMAKE_MAKE_PROGRAM NAMES ninja ninja.exe HINTS
        "${_smtc_vs}/Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja" REQUIRED)
endif()

set(_smtc_includes
    "${_smtc_vc}/include"
    "${_smtc_kits}/Include/${_smtc_sdk}/ucrt"
    "${_smtc_kits}/Include/${_smtc_sdk}/shared"
    "${_smtc_kits}/Include/${_smtc_sdk}/um"
    "${_smtc_kits}/Include/${_smtc_sdk}/winrt"
    "${_smtc_kits}/Include/${_smtc_sdk}/cppwinrt")
set(_smtc_libs
    "${_smtc_vc}/lib/x64"
    "${_smtc_kits}/Lib/${_smtc_sdk}/ucrt/x64"
    "${_smtc_kits}/Lib/${_smtc_sdk}/um/x64")

# 平台级系统头文件目录会出现在每个 target 的实际编译命令中。
# 不使用仅首次配置生效的 FLAGS_INIT，已有构建目录重新 configure 也能生效。
set(CMAKE_C_STANDARD_INCLUDE_DIRECTORIES "${_smtc_includes}")
set(CMAKE_CXX_STANDARD_INCLUDE_DIRECTORIES "${_smtc_includes}")
set(CMAKE_RC_STANDARD_INCLUDE_DIRECTORIES "${_smtc_includes}")
# 保留 CMake.js 传入的 /DELAYLOAD 等参数，并补充所有链接目标的 SDK 搜索路径。
foreach(_smtc_kind IN ITEMS EXE SHARED MODULE STATIC)
    foreach(_smtc_lib IN LISTS _smtc_libs)
        set(_smtc_flag "/LIBPATH:\"${_smtc_lib}\"")
        string(FIND "${CMAKE_${_smtc_kind}_LINKER_FLAGS}" "${_smtc_flag}" _smtc_found)
        if(_smtc_found EQUAL -1)
            string(APPEND CMAKE_${_smtc_kind}_LINKER_FLAGS " ${_smtc_flag}")
        endif()
    endforeach()
endforeach()

# 仅为配置阶段的工具探测提供环境；实际编译、链接不依赖这些变量。
set(ENV{INCLUDE} "${_smtc_includes}")
set(ENV{LIB} "${_smtc_libs}")
set(ENV{PATH} "${_smtc_bin};${_smtc_sdk_bin};$ENV{PATH}")
