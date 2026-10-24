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

  # Rust core (uniffi) as a binary framework produced by core/build-mobile.sh. When absent the pod still
  # installs so the JS side can be worked on; `import safety` then fails at compile time.
  xcframework = File.join(__dir__, 'Frameworks', 'safety.xcframework')
  s.vendored_frameworks = 'Frameworks/safety.xcframework' if File.directory?(xcframework)

  s.source_files  = '*.swift', 'Generated/*.swift'
  s.exclude_files = 'Widget/**'
  resources = Dir[File.join(__dir__, 'Resources', '*.{tflite,csv,caf,wav,toml}')]
  s.resources = 'Resources/*.{tflite,csv,caf,wav,toml}' unless resources.empty?

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }
end
