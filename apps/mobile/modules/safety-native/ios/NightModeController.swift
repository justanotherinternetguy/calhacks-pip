import CoreLocation
import Foundation

struct HomePlace: Codable {
    var id: String
    var label: String
    var lat: Double
    var lng: Double
    var radiusM: Double
}

/// Decides when night mode is active and owns the single CLLocationManager.
///
/// Day: significant-location-change monitoring + one `CLCircularRegion` per home place. Both relaunch
/// the app after it has been killed. Night (away from home ∧ inside the evening window, or mode `on`):
/// continuous location with `allowsBackgroundLocationUpdates` keeps the process alive so CoreMotion
/// keeps sampling. All CLLocationManager calls happen on the main thread.
final class NightModeController: NSObject, CLLocationManagerDelegate {
    enum Mode: String { case auto, on, off, pausedTonight = "paused_tonight" }

    private var manager: CLLocationManager!
    private let defaults = UserDefaults.standard

    private(set) var homes: [HomePlace] = Store.loadJSON("homes.json") ?? []
    private(set) var mode: Mode
    private(set) var windowStart: Int   // local hour, default 20
    private(set) var windowEnd: Int     // local hour, default 6
    private var pausedUntil: Date?
    private(set) var awayFromHome = false
    private(set) var active = false
    private(set) var since: Date?
    private(set) var reason = "off"
    private var continuous = false
    private var evalTimer: Timer?
    private var authWaiters: [(CLAuthorizationStatus) -> Void] = []

    /// (active, reason) — called on the main thread whenever the decision changes.
    var onChange: ((Bool, String) -> Void)?
    var onLocation: ((CLLocation) -> Void)?

    override init() {
        mode = Mode(rawValue: defaults.string(forKey: "safe.nightMode") ?? "auto") ?? .auto
        windowStart = defaults.object(forKey: "safe.windowStart") as? Int ?? 20
        windowEnd = defaults.object(forKey: "safe.windowEnd") as? Int ?? 6
        pausedUntil = defaults.object(forKey: "safe.pausedUntil") as? Date
        super.init()
    }

    // MARK: lifecycle

    func start() {
        onMain {
            guard self.manager == nil else { return }
            let m = CLLocationManager()
            m.delegate = self
            m.pausesLocationUpdatesAutomatically = false
            m.allowsBackgroundLocationUpdates = true   // requires UIBackgroundModes: location
            m.showsBackgroundLocationIndicator = false
            m.desiredAccuracy = kCLLocationAccuracyHundredMeters
            m.distanceFilter = 25
            self.manager = m
            m.startMonitoringSignificantLocationChanges()
            self.refreshGeofences()
            if let loc = m.location { self.updateAway(from: loc) }
            self.evalTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.evaluate() }
            self.evaluate()
        }
    }

    func startContinuousLocation() {
        onMain {
            guard !self.continuous, let m = self.manager else { return }
            self.continuous = true
            m.desiredAccuracy = kCLLocationAccuracyHundredMeters
            m.startUpdatingLocation()
        }
    }

    func stopContinuousLocation() {
        onMain {
            guard self.continuous else { return }
            self.continuous = false
            self.manager?.stopUpdatingLocation()
        }
    }

    var lastKnownLocation: CLLocation? { manager?.location }

    // MARK: settings

    func setMode(_ m: Mode) {
        onMain {
            self.mode = m
            self.defaults.set(m.rawValue, forKey: "safe.nightMode")
            if m == .pausedTonight {
                self.pausedUntil = self.nextWindowEnd()
            } else {
                self.pausedUntil = nil
            }
            self.defaults.set(self.pausedUntil, forKey: "safe.pausedUntil")
            self.evaluate()
        }
    }

    func setWindow(start: Int, end: Int) {
        onMain {
            self.windowStart = max(0, min(23, start))
            self.windowEnd = max(0, min(23, end))
            self.defaults.set(self.windowStart, forKey: "safe.windowStart")
            self.defaults.set(self.windowEnd, forKey: "safe.windowEnd")
            self.evaluate()
        }
    }

    func setHomes(_ h: [HomePlace]) {
        onMain {
            self.homes = h
            Store.saveJSON(h, "homes.json")
            self.refreshGeofences()
            if let loc = self.manager?.location { self.updateAway(from: loc) }
            self.evaluate()
        }
    }

    // MARK: decision

    private func inWindow(_ hour: Int) -> Bool {
        if windowStart == windowEnd { return true }
        if windowStart < windowEnd { return hour >= windowStart && hour < windowEnd }
        return hour >= windowStart || hour < windowEnd
    }

    private func nextWindowEnd() -> Date {
        let cal = Calendar.current
        var comps = cal.dateComponents([.year, .month, .day], from: Date())
        comps.hour = windowEnd
        var d = cal.date(from: comps) ?? Date()
        if d <= Date() { d = cal.date(byAdding: .day, value: 1, to: d) ?? d }
        return d
    }

    func evaluate() {
        onMain {
            if let p = self.pausedUntil, p <= Date() {
                self.pausedUntil = nil
                self.defaults.set(nil, forKey: "safe.pausedUntil")
                if self.mode == .pausedTonight { self.setMode(.auto); return }
            }
            let hour = Calendar.current.component(.hour, from: Date())
            let shouldBeActive: Bool
            let why: String
            switch self.mode {
            case .on: shouldBeActive = true; why = "manual"
            case .off, .pausedTonight: shouldBeActive = false; why = "off"
            case .auto:
                let inW = self.inWindow(hour)
                shouldBeActive = inW && self.awayFromHome
                why = inW ? "away_from_home" : "window"
            }
            guard shouldBeActive != self.active || why != self.reason else { return }
            let flipped = shouldBeActive != self.active
            self.active = shouldBeActive
            self.reason = why
            if flipped { self.since = shouldBeActive ? Date() : nil }
            self.onChange?(shouldBeActive, why)
        }
    }

    private func setAway(_ away: Bool) {
        guard away != awayFromHome else { return }
        awayFromHome = away
        evaluate()
    }

    /// Metres from `loc` to the centre of the nearest saved home (edge of the radius is *not* subtracted);
    /// nil when no homes are configured. Feeds `Context.distanceHomeM` (CONTRACTS §6, -1 = unknown).
    func distanceToNearestHome(from loc: CLLocation) -> Double? {
        homes.map { loc.distance(from: CLLocation(latitude: $0.lat, longitude: $0.lng)) }.min()
    }

    private func updateAway(from loc: CLLocation) {
        guard !homes.isEmpty else { return }   // no homes configured → never "away"; auto mode stays idle
        let atHome = homes.contains { h in
            let d = loc.distance(from: CLLocation(latitude: h.lat, longitude: h.lng))
            return d <= max(h.radiusM, 100) + max(0, loc.horizontalAccuracy)
        }
        setAway(!atHome)
    }

    private func refreshGeofences() {
        guard let m = manager else { return }
        for r in m.monitoredRegions where r.identifier.hasPrefix("home:") { m.stopMonitoring(for: r) }
        guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        for h in homes.prefix(18) {   // iOS caps regions at 20 per app
            let radius = min(max(h.radiusM, 100), m.maximumRegionMonitoringDistance)
            let r = CLCircularRegion(center: CLLocationCoordinate2D(latitude: h.lat, longitude: h.lng), radius: radius, identifier: "home:\(h.id)")
            r.notifyOnExit = true
            r.notifyOnEntry = true
            m.startMonitoring(for: r)
            m.requestState(for: r)
        }
    }

    // MARK: permissions

    static func mapAuth(_ s: CLAuthorizationStatus) -> String {
        switch s {
        case .authorizedAlways: return "granted"
        case .denied, .restricted: return "denied"
        default: return "undetermined"   // .notDetermined / .authorizedWhenInUse (upgradeable)
        }
    }

    var authorization: String { NightModeController.mapAuth(manager?.authorizationStatus ?? .notDetermined) }

    func requestAlways(_ done: @escaping (String) -> Void) {
        onMain {
            guard let m = self.manager else { done("undetermined"); return }
            let s = m.authorizationStatus
            if s == .authorizedAlways || s == .denied || s == .restricted { done(Self.mapAuth(s)); return }
            self.authWaiters.append { done(Self.mapAuth($0)) }
            // From .notDetermined iOS shows the when-in-use prompt and grants provisional Always; from
            // .authorizedWhenInUse it shows the Always upgrade prompt (once).
            m.requestAlwaysAuthorization()
        }
    }

    // MARK: CLLocationManagerDelegate (main thread)

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        updateAway(from: loc)
        onLocation?(loc)
    }

    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        if region.identifier.hasPrefix("home:") { setAway(true) }
    }

    func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        if region.identifier.hasPrefix("home:") { setAway(false) }
    }

    func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
        guard region.identifier.hasPrefix("home:") else { return }
        if state == .inside { setAway(false) } else if state == .outside, let loc = manager.location { updateAway(from: loc) }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let s = manager.authorizationStatus
        guard s != .notDetermined else { return }
        let waiters = authWaiters
        authWaiters = []
        waiters.forEach { $0(s) }
        if s == .authorizedAlways || s == .authorizedWhenInUse {
            manager.startMonitoringSignificantLocationChanges()
            refreshGeofences()
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { /* transient; keep going */ }

    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }
}
