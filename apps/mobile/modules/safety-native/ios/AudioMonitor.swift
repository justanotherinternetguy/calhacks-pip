import AVFoundation
import Foundation
#if canImport(TensorFlowLite)
import TensorFlowLite
#endif

/// YAMNet (TFLite / LiteRT) over 0.975 s @ 16 kHz windows (15600 samples). Output 0 is [1, 521] scores.
/// Class indices come from `yamnet_class_map.csv` in the bundle when present, else the published defaults.
final class YamnetClassifier {
    struct Scores { var scream: Float; var shout: Float; var glass: Float }
    static let windowSamples = 15600
    private var screamIdx = [11]          // "Screaming"
    private var shoutIdx = [6, 7, 9]      // "Shout", "Bellow", "Yell"
    private var glassIdx = [435, 437]     // "Glass", "Shatter"
    #if canImport(TensorFlowLite)
    private var interpreter: Interpreter?
    #endif

    var isLoaded: Bool {
        #if canImport(TensorFlowLite)
        return interpreter != nil
        #else
        return false
        #endif
    }

    init() {
        #if canImport(TensorFlowLite)
        if let path = Bundle.main.path(forResource: "yamnet", ofType: "tflite") {
            var opts = Interpreter.Options()
            opts.threadCount = 1
            if let i = try? Interpreter(modelPath: path, options: opts) {
                try? i.resizeInput(at: 0, to: Tensor.Shape([Self.windowSamples]))
                if (try? i.allocateTensors()) != nil { interpreter = i }
            }
        }
        #endif
        loadClassMap()
    }

    private func loadClassMap() {
        guard let url = Bundle.main.url(forResource: "yamnet_class_map", withExtension: "csv"),
              let text = try? String(contentsOf: url) else { return }
        var scream: [Int] = [], shout: [Int] = [], glass: [Int] = []
        for line in text.split(separator: "\n").dropFirst() {   // index,mid,display_name
            let cols = line.split(separator: ",", maxSplits: 2).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            guard cols.count == 3, let idx = Int(cols[0]) else { continue }
            let name = cols[2].replacingOccurrences(of: "\"", with: "").lowercased()
            if name == "screaming" { scream.append(idx) }
            else if ["shout", "yell", "bellow", "whoop", "children shouting"].contains(name) { shout.append(idx) }
            else if ["glass", "shatter"].contains(name) { glass.append(idx) }
        }
        if !scream.isEmpty { screamIdx = scream }
        if !shout.isEmpty { shoutIdx = shout }
        if !glass.isEmpty { glassIdx = glass }
    }

    func classify(_ window: [Float]) -> Scores? {
        #if canImport(TensorFlowLite)
        guard let interpreter, window.count == Self.windowSamples else { return nil }
        do {
            _ = try interpreter.copy(window.withUnsafeBufferPointer { Data(buffer: $0) }, toInputAt: 0)
            try interpreter.invoke()
            let probs: [Float] = try interpreter.output(at: 0).data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
            func maxAt(_ idx: [Int]) -> Float { idx.compactMap { $0 < probs.count ? probs[$0] : nil }.max() ?? 0 }
            return Scores(scream: maxAt(screamIdx), shout: maxAt(shoutIdx), glass: maxAt(glassIdx))
        } catch { return nil }
        #else
        return nil
        #endif
    }
}

/// Keeps one AVAudioEngine running for the whole night session (iOS may refuse to *start* the mic in
/// the background — PLAN §2 day-1 spike) and only runs the classifier on scheduled windows:
/// 5 s of every 30 s, continuous for 2 min after any motion signal (`boost`).
final class AudioMonitor {
    private let engine = AVAudioEngine()
    private let classifier = YamnetClassifier()
    private let q = DispatchQueue(label: "app.safe.audio", qos: .utility)
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?
    private var pcm: [Float] = []
    private var capturing = false
    private var cycleStart = Date.distantPast
    private var boostUntil = Date.distantPast
    private var observers: [NSObjectProtocol] = []
    private(set) var running = false

    var onScores: ((AudioScores) -> Void)?
    var available: Bool { classifier.isLoaded }

    static var permission: String {
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        default: return "undetermined"
        }
    }

    static func requestPermission(_ done: @escaping (String) -> Void) {
        AVAudioSession.sharedInstance().requestRecordPermission { done($0 ? "granted" : "denied") }
    }

    func start() throws {
        guard !running else { return }
        guard classifier.isLoaded else { throw SafeError("yamnet.tflite not bundled") }
        guard AVAudioSession.sharedInstance().recordPermission == .granted else { throw SafeError("microphone permission") }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else { throw SafeError("no microphone input") }
        converter = AVAudioConverter(from: inFormat, to: targetFormat)
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buf, _ in
            self?.q.async { self?.ingest(buf) }
        }
        engine.prepare()
        try engine.start()
        running = true
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] n in
            guard let self, let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
            try? AVAudioSession.sharedInstance().setActive(true)
            try? self.engine.start()
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
            guard let self, self.running else { return }
            self.stop(); try? self.start()
        })
    }

    func stop() {
        guard running else { return }
        running = false
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        q.async { self.pcm.removeAll(); self.capturing = false }
    }

    /// Continuous classification for `seconds` (called after motion signals / risk changes).
    func boost(seconds: TimeInterval) { q.async { self.boostUntil = max(self.boostUntil, Date().addingTimeInterval(seconds)) } }

    /// Called once per second from the coordinator tick; decides whether windows are classified.
    func schedule(now: Date = Date()) {
        q.async {
            if now.timeIntervalSince(self.cycleStart) >= 30 { self.cycleStart = now }
            let inDuty = now.timeIntervalSince(self.cycleStart) < 5
            let should = self.running && (inDuty || now < self.boostUntil)
            if should != self.capturing {
                self.capturing = should
                self.pcm.removeAll(keepingCapacity: true)
            }
        }
    }

    private func ingest(_ buf: AVAudioPCMBuffer) {
        guard capturing, let converter else { return }
        let ratio = targetFormat.sampleRate / buf.format.sampleRate
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: AVAudioFrameCount(Double(buf.frameLength) * ratio) + 32) else { return }
        var consumed = false
        var err: NSError?
        _ = converter.convert(to: out, error: &err) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buf
        }
        guard err == nil, let ch = out.floatChannelData else { return }
        pcm.append(contentsOf: UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength)))
        while pcm.count >= YamnetClassifier.windowSamples {
            let window = Array(pcm[0..<YamnetClassifier.windowSamples])
            pcm.removeFirst(YamnetClassifier.windowSamples)
            if let s = classifier.classify(window) {
                onScores?(AudioScores(tMs: SafeClock.nowMs(), scream: s.scream, shout: s.shout, glass: s.glass))
            }
        }
    }
}
