{
  "targets": [{
    "target_name": "windows_launch",
    "sources": ["native/windows-launch.cc"],
    "libraries": ["advapi32.lib"],
    "msvs_settings": {
      "VCCLCompilerTool": { "ExceptionHandling": 1 }
    }
  }, {
    "target_name": "windows_plan_sbx",
    "type": "executable",
    "sources": ["test/native/windows-plan-sbx.cc"]
  }]
}
