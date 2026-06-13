{
  "targets": [
    {
      "target_name": "pcpanel_audio",
      "sources": [
        "src/audio_passthrough.mm",
        "src/process_tap.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "14.4",
        "OTHER_CFLAGS": [
          "-ObjC++",
          "-fobjc-arc"
        ]
      },
      "link_settings": {
        "libraries": [
          "-framework CoreAudio",
          "-framework AudioToolbox",
          "-framework CoreFoundation",
          "-framework Foundation",
          "-framework AppKit"
        ]
      },
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"]
    }
  ]
}
