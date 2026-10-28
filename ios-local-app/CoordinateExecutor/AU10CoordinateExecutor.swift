//
// AU10CoordinateExecutor.swift
//
// Experimental jailbreak-only coordinate injector for iOS 15.x.
// IMPORTANT: This uses private IOKit HID APIs and is not supported by public iOS SDKs.
// It intentionally defaults to disabled and must not be used to submit real-money orders
// until touch delivery and the target screen geometry have been independently verified.
//

import Foundation
import CoreFoundation
import UIKit
import WebKit
import Darwin

@objc(AU10CoordinateExecutor)
final class AU10CoordinateExecutor: NSObject {
    static let shared = AU10CoordinateExecutor()

    // Explicit opt-in is required at runtime. Never enable by default in a release build.
    private(set) var enabled = false

    private typealias CreateClientFn = @convention(c) (CFAllocator?) -> Unmanaged<AnyObject>?
    private typealias CreateDigitizerFn = @convention(c) (
        CFAllocator?, UInt64, Int32, Int32, Int32,
        Double, Double, Double, Double, Double, Double,
        Int32, Int32, Int32
    ) -> Unmanaged<AnyObject>?
    private typealias SetIntegerFn = @convention(c) (AnyObject, UInt32, Int64) -> Void
    private typealias DispatchFn = @convention(c) (AnyObject, AnyObject) -> Void

    private var client: AnyObject?
    private var createDigitizer: CreateDigitizerFn?
    private var setInteger: SetIntegerFn?
    private var dispatchEvent: DispatchFn?
    private var lastDispatchTime: TimeInterval = 0

    private override init() {
        super.init()
        loadPrivateHIDSymbols()
    }

    /// Call only from a deliberate, visible user action in a jailbroken test build.
    /// This does not bypass app/site authorization and does not prove the UI acted on the touch.
    @discardableResult
    func setEnabled(_ value: Bool) -> Bool {
        guard !value || symbolsAvailable else { enabled = false; return false }
        enabled = value
        return true
    }

    var symbolsAvailable: Bool {
        return client != nil && createDigitizer != nil && setInteger != nil && dispatchEvent != nil
    }

    /// Inject one short finger tap in screen points. Coordinates are absolute screen points,
    /// not normalized web-view coordinates. Returns true only if the private dispatch call ran.
    /// It cannot guarantee that the intended control received the touch.
    @discardableResult
    func tap(screenX: CGFloat, screenY: CGFloat) -> Bool {
        guard enabled, symbolsAvailable,
              screenX.isFinite, screenY.isFinite,
              screenX >= 0, screenY >= 0,
              screenX < UIScreen.main.bounds.width,
              screenY < UIScreen.main.bounds.height,
              let client,
              let createDigitizer,
              let setInteger,
              let dispatchEvent else { return false }

        // Rate limit to avoid runaway loops from a misconfigured caller.
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastDispatchTime >= 0.12 else { return false }
        lastDispatchTime = now

        // Private HID digitizer constants. These values are version-sensitive.
        let transducerFinger: Int32 = 2
        let eventRange: UInt32 = 0xB000B
        let eventTouch: UInt32 = 0xB000C
        let eventDisplayIntegrated: UInt32 = 0xB0010
        let eventIdentity: UInt32 = 0xB0011
        let eventIndex: UInt32 = 0xB0012
        let eventPositionX: UInt32 = 0xB0013
        let eventPositionY: UInt32 = 0xB0014
        let eventPhase: UInt32 = 0xB0015

        func send(phase: Int32, touching: Bool) -> Bool {
            let stamp = UInt64(now * 1_000_000)
            guard let event = createDigitizer(
                kCFAllocatorDefault, stamp, transducerFinger, 0, 0,
                Double(screenX), Double(screenY), 0, 0,
                1, 1, 0, 0, 0
            )?.takeRetainedValue() else { return false }

            setInteger(event, eventRange, 1)
            setInteger(event, eventTouch, touching ? 1 : 0)
            setInteger(event, eventDisplayIntegrated, 1)
            setInteger(event, eventIdentity, 1)
            setInteger(event, eventIndex, 0)
            setInteger(event, eventPositionX, Int64(screenX * 65536))
            setInteger(event, eventPositionY, Int64(screenY * 65536))
            setInteger(event, eventPhase, Int64(phase))
            dispatchEvent(client, event)
            return true
        }

        // A press and release are separate HID events; private phase values can vary by iOS.
        guard send(phase: 1, touching: true) else { return false }
        usleep(70_000)
        return send(phase: 0, touching: false)
    }

    private func loadPrivateHIDSymbols() {
        // The framework may not expose these symbols to a sandboxed process.
        // A jailbreak tweak/privileged host may be required even when they resolve.
        let paths = [
            "/System/Library/Frameworks/IOKit.framework/IOKit",
            "/System/Library/PrivateFrameworks/IOKit.framework/IOKit"
        ]
        var handle: UnsafeMutableRawPointer?
        for path in paths {
            handle = dlopen(path, RTLD_NOW)
            if handle != nil { break }
        }
        guard let handle else { return }

        guard let createClientSym = dlsym(handle, "IOHIDEventSystemClientCreate"),
              let createDigitizerSym = dlsym(handle, "IOHIDEventCreateDigitizerEvent"),
              let setIntegerSym = dlsym(handle, "IOHIDEventSetIntegerValue"),
              let dispatchSym = dlsym(handle, "IOHIDEventSystemClientDispatchEvent") else {
            return
        }

        let createClient = unsafeBitCast(createClientSym, to: CreateClientFn.self)
        self.createDigitizer = unsafeBitCast(createDigitizerSym, to: CreateDigitizerFn.self)
        self.setInteger = unsafeBitCast(setIntegerSym, to: SetIntegerFn.self)
        self.dispatchEvent = unsafeBitCast(dispatchSym, to: DispatchFn.self)
        self.client = createClient(kCFAllocatorDefault)?.takeRetainedValue()
    }
}


/// WKWebView bridge. It dispatches test taps into the app's own web view geometry.
/// The final-submit control is deliberately blocked in this experimental build.
@objc(AU10CoordinateMessageHandler)
final class AU10CoordinateMessageHandler: NSObject, WKScriptMessageHandler {
    override init() {
        super.init()
        _ = AU10CoordinateExecutor.shared.setEnabled(true)
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "au10CoordinateExecutor",
              let body = message.body as? [String: Any],
              let x = body["x"] as? NSNumber,
              let y = body["y"] as? NSNumber else { return }

        let label = String(describing: body["label"] ?? "")
        let requestID = String(describing: body["requestId"] ?? "")
        // Keep real-money submission disabled: this handler never injects the final confirmation tap.
        guard label != "最终确认投注" && label != "final-confirm" else { return }

        DispatchQueue.main.async {
            guard let webView = Self.findWebView(in: UIApplication.shared),
                  let window = webView.window else { return }
            let pointInWebView = CGPoint(x: CGFloat(truncating: x), y: CGFloat(truncating: y))
            let pointInWindow = webView.convert(pointInWebView, to: window)
            let screenPoint = window.convert(pointInWindow, to: UIScreen.main.coordinateSpace)
            let dispatched = AU10CoordinateExecutor.shared.tap(screenX: screenPoint.x, screenY: screenPoint.y)

            // Report only whether the private HID dispatch call ran; this is not proof that
            // the intended webpage control received or accepted the touch.
            let result: [String: Any] = [
                "type": "AU10_NATIVE_TAP_RESULT",
                "requestId": requestID,
                "label": label,
                "dispatched": dispatched
            ]
            if let data = try? JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed]),
               let json = String(data: data, encoding: .utf8) {
                webView.evaluateJavaScript("window.postMessage(\(json), '*')", completionHandler: nil)
            }
        }
    }

    private static func findWebView(in application: UIApplication) -> WKWebView? {
        func search(_ view: UIView) -> WKWebView? {
            if let webView = view as? WKWebView { return webView }
            for child in view.subviews {
                if let found = search(child) { return found }
            }
            return nil
        }
        for window in application.windows {
            if let found = search(window) { return found }
        }
        return nil
    }
}
