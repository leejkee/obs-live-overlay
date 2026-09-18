{
  "variables": { "smtc_fixture%": 0 },
  "targets": [
    {
      "target_name": "smtc",
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_VERSION=8", "NAPI_CPP_EXCEPTIONS", "NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
      "sources": [
        "src/native/addon.cpp"
      ],
      "conditions": [["OS=='win'", {
        "libraries": ["windowsapp.lib"],
        "msvs_settings": {"VCCLCompilerTool": {"ExceptionHandling": 1, "AdditionalOptions": ["/std:c++20", "/permissive-", "/utf-8", "/bigobj"]}}
      }, {"type": "none", "sources": []}]]
    },
    {
      "target_name": "smtc_fixture",
      "conditions": [["OS=='win' and smtc_fixture==1", {
        "type": "executable",
        "sources": ["test/native/media-fixture.cpp"],
        "defines": ["WIN32_LEAN_AND_MEAN", "NOMINMAX"],
        "libraries": ["windowsapp.lib"],
        "msvs_settings": {
          "VCCLCompilerTool": {"ExceptionHandling": 1, "AdditionalOptions": ["/std:c++20", "/permissive-", "/utf-8"]},
          "VCLinkerTool": {"SubSystem": 1}
        }
      }, {"type": "none"}]]
    }
  ]
}
