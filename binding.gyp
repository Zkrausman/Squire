{
  "targets": [{
    "target_name": "windows_launch",
    "sources": ["native/windows-launch.cc"],
    "libraries": ["advapi32.lib"],
    "msvs_settings": {
      "VCCLCompilerTool": { "ExceptionHandling": 1 }
    }
  }]
}
