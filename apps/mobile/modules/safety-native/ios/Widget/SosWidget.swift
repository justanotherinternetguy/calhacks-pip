// Lock-screen / Home-screen SOS widget. NOT compiled into the SafetyNative pod (excluded in the podspec).
//
// Xcode setup (one-time, see README): File ▸ New ▸ Target ▸ Widget Extension "SafeWidget"; add this file
// and ../AppIntents.swift to that target; add `SAFE_WIDGET_EXTENSION` to the target's
// "Active Compilation Conditions"; share an App Group if you later want the widget to show status.
#if SAFE_WIDGET_EXTENSION
import AppIntents
import SwiftUI
import WidgetKit

struct SosEntry: TimelineEntry { let date: Date }

struct SosProvider: TimelineProvider {
    func placeholder(in context: Context) -> SosEntry { SosEntry(date: Date()) }
    func getSnapshot(in context: Context, completion: @escaping (SosEntry) -> Void) { completion(SosEntry(date: Date())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<SosEntry>) -> Void) {
        completion(Timeline(entries: [SosEntry(date: Date())], policy: .never))
    }
}

@available(iOS 17.0, *)
struct SosWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "SosWidget", provider: SosProvider()) { _ in
            Button(intent: TriggerSosIntent()) {
                Label("SOS", systemImage: "sos.circle.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .buttonStyle(.plain)
            .containerBackground(.red.gradient, for: .widget)
        }
        .configurationDisplayName("SOS")
        .description("Alert your friends with one tap.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .systemSmall])
    }
}

@main
struct SafeWidgetBundle: WidgetBundle {
    var body: some Widget {
        if #available(iOS 17.0, *) { SosWidget() }
    }
}
#endif
