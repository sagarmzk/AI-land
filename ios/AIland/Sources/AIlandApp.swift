import SwiftUI
import WebKit

@main
struct AIlandApp: App {
    var body: some Scene {
        WindowGroup {
            PanelView()
                .ignoresSafeArea()
                .preferredColorScheme(.dark)
        }
    }
}

struct PanelView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(StoreBridge.shared, name: StoreBridge.handlerName)
        controller.addUserScript(
            WKUserScript(
                source: StoreBridge.shared.bootstrapScript(),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.scrollView.showsVerticalScrollIndicator = false
        web.allowsLinkPreview = false

        if let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "www") {
            web.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
        }
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// WKWebView gives file:// pages an opaque origin, so the app's own localStorage is
/// replaced by a shim that mirrors every write into UserDefaults.
final class StoreBridge: NSObject, WKScriptMessageHandler {
    static let shared = StoreBridge()
    static let handlerName = "ailandStore"

    private let defaultsKey = "ailand.webstore"

    func bootstrapScript() -> String {
        let snapshot = defaults.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
        let json = (try? JSONSerialization.data(withJSONObject: snapshot))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return """
        (function () {
          try {
            var data = \(json);
            var memory = new Map(Object.entries(data || {}));
            function post(op, key, value) {
              try {
                window.webkit.messageHandlers.\(Self.handlerName).postMessage({ op: op, key: key, value: value });
              } catch (e) {}
            }
            var shim = {
              getItem: function (k) { k = String(k); return memory.has(k) ? memory.get(k) : null; },
              setItem: function (k, v) { k = String(k); v = String(v); memory.set(k, v); post('set', k, v); },
              removeItem: function (k) { k = String(k); memory.delete(k); post('remove', k); },
              clear: function () { memory.clear(); post('clear'); },
              key: function (i) { var keys = Array.from(memory.keys()); return i >= 0 && i < keys.length ? keys[i] : null; }
            };
            Object.defineProperty(shim, 'length', { get: function () { return memory.size; } });
            Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
            Object.defineProperty(window, 'sessionStorage', { configurable: true, value: shim });
          } catch (e) {}
        })();
        """
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else { return }
        var store = defaults.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
        switch op {
        case "set":
            if let key = body["key"] as? String, let value = body["value"] as? String {
                store[key] = value
            }
        case "remove":
            if let key = body["key"] as? String {
                store.removeValue(forKey: key)
            }
        case "clear":
            store.removeAll()
        default:
            return
        }
        UserDefaults.standard.set(store, forKey: defaultsKey)
    }
}
