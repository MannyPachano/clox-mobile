# The app's own Expo module for the running shift outside the app (the Live
# Activity and the Home Screen widget on iOS). Autolinked from modules/.
Pod::Spec.new do |s|
  s.name           = 'CloxShiftSurface'
  s.version        = '1.0.0'
  s.summary        = 'The running shift on the Lock Screen, in the Dynamic Island and in the Home Screen widget.'
  s.description    = 'Writes the shared state the Clox widget extension reads, saves Live Activity and widget taps for the app to queue, and starts, updates and ends the Live Activity.'
  s.author         = 'Clox'
  s.homepage       = 'https://getclox.com'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Both are newer than the app's iOS 15.1, so both are weak-linked: an
  # iPhone on iOS 15 must still launch the app. ActivityKit is used here.
  # AppIntents is used by ShiftActionIntent (targets/widget/_shared), which
  # compiles into the app target; this pod is how the app target gets the
  # weak link, because a static pod's frameworks go on the app's link line.
  s.weak_frameworks = 'ActivityKit', 'AppIntents'
  s.frameworks = 'WidgetKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.swift'
end
