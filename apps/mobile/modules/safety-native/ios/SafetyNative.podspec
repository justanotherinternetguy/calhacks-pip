Pod::Spec.new do |s|
  s.name           = 'SafetyNative'
  s.version        = '0.1.0'
  s.summary        = 'Native sensing, escrow and alerting for the safe app'
  s.description    = 'Night-mode controller, CoreMotion/CoreLocation sensing, YAMNet audio scoring, ' \
                     'Supabase uploads and the uniffi bridge to the Rust safety core.'
  s.author         = 'safe'
  s.homepage       = 'https://github.com/justanotherinternetguy/safe'
  s.license        = { type: 'MIT' }
  s.platforms      = { ios: '16.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # YAMNet classifier. Swift module name is `TensorFlowLite`; AudioMonitor is guarded by `#if canImport`,
  # so removing this line simply disables audio scoring.
  s.dependency 'TensorFlowLiteSwift', '~> 2.14'

  s.frameworks = 'CoreMotion', 'CoreLocation', 'AVFoundation', 'UserNotifications', 'LocalAuthentication', 'CryptoKit'
  s.weak_frameworks = 'AppIntents', 'WidgetKit'

  # Rust core (uniffi), produced by core/build-mobile.sh:
  #   Frameworks/safety.xcframework   static libsafety_ffi.a (device + simulator) + the C header
  #   Generated/safety.swift          uniffi Swift bindings, compiled INTO this pod (no `import safety` anywhere)
  #   Generated/safetyFFI.h           C FFI header the bindings call through
  #   Generated/*.modulemap           Clang module `safetyFFI` wrapping that header
  # `Generated/safety.swift` does `#if canImport(safetyFFI) import safetyFFI #endif`, so the module map must be
  # visible to the Swift compiler. We hand it to Clang explicitly (`-fmodule-map-file`) instead of relying on
  # CocoaPods' xcframework header handling; this also works whether the map is named `module.modulemap`
  # (build-mobile.sh) or `safetyFFI.modulemap` (raw `uniffi-bindgen` output). The header is deliberately NOT a
  # pod source/public header: adding it to the SafetyNative umbrella would define the FFI types twice.
  # When the xcframework is absent the pod still installs so the JS side can be worked on; linking then fails
  # with undefined `uniffi_safety_ffi_*` symbols.
  xcframework = File.join(__dir__, 'Frameworks', 'safety.xcframework')
  s.vendored_frameworks = 'Frameworks/safety.xcframework' if File.directory?(xcframework)

  modulemap = Dir[File.join(__dir__, 'Generated', '*.modulemap')].sort.first
  modulemap_name = modulemap ? File.basename(modulemap) : 'safetyFFI.modulemap'

  s.source_files  = '*.swift', 'Generated/*.swift'
  s.exclude_files = 'Widget/**'
  s.preserve_paths = 'Generated/safetyFFI.h', 'Generated/*.modulemap'
  resources = Dir[File.join(__dir__, 'Resources', '*.{tflite,csv,caf,wav,toml}')]
  s.resources = 'Resources/*.{tflite,csv,caf,wav,toml}' unless resources.empty?

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    # Make Clang module `safetyFFI` (Generated/safetyFFI.h) importable from Generated/safety.swift.
    'OTHER_SWIFT_FLAGS' => "$(inherited) -Xcc -fmodule-map-file=\"$(PODS_TARGET_SRCROOT)/Generated/#{modulemap_name}\"",
  }
end
