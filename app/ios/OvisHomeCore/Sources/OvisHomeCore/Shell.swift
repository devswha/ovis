import Foundation

/// The shell served from inside the app (docs/native-app.md, The shell inside the app): a build made with
/// OVIS_APP_SHELL=bundled carries the hosted app's files and serves them itself at `capacitor://<the hosted origin's
/// host>`, never from the network. What is decided here is carried out by ShellHost.swift, PCStore and the plugins.
extension Home {
    /// The scheme of the pages the app serves itself: its own (`capacitor://localhost`) and, in such a build, the shell's.
    public static let appScheme = "capacitor"

    /// The host of the app's own pages (app/web), which is never the shell's.
    public static let bundledHost = "localhost"

    /// Where the shell's pages are: the hosted origin itself (`hosted`, the build's OvisAppOrigin), or, in a build
    /// that serves the shell from inside the app (`bundled`), that origin's host on the app's own scheme. Nil where
    /// nothing is the shell: no hosted origin, or one whose host is the app's own pages' or is no plain DNS name.
    public static func shellOrigin(hosted: URL?, bundled: Bool) -> URL? {
        guard bundled else { return hosted }
        guard let host = hosted?.host?.lowercased(), !host.isEmpty, host != bundledHost,
              host.utf8.allSatisfy({ plainHostByte($0) }) else { return nil }
        return URL(string: "\(appScheme)://\(host)")
    }

    private static func plainHostByte(_ byte: UInt8) -> Bool {
        (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte) || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
            || byte == UInt8(ascii: ".") || byte == UInt8(ascii: "-")
    }

    /// Whether `url` is one of the app's own bundled pages (app/web: the connect page, the error page, the demo), by
    /// its scheme and host, which a page cannot choose: the shell a build serves from inside the app is on the same
    /// scheme at another host, and is not one. Only these pages manage SSH PCs.
    public static func bundledPage(_ url: URL?) -> Bool {
        url?.scheme?.lowercased() == appScheme && url?.host?.lowercased() == bundledHost && url?.port == nil
    }

    /// Whether a frame's origin, as WebKit reports it (`scheme`, `host`, and `port`, 0 for the scheme's own), is the
    /// shell's at `shell` (shellOrigin): the hosted app over https, or its copy inside the app on the app's own
    /// scheme, which has no port. Plain http is never the shell.
    public static func shellFrame(scheme: String, host: String, port: Int, shell: URL?) -> Bool {
        guard let shell, let shellScheme = shell.scheme?.lowercased(), let shellHost = shell.host?.lowercased(), !shellHost.isEmpty,
              scheme.lowercased() == shellScheme, host.lowercased() == shellHost else { return false }
        if shellScheme == appScheme { return port == 0 && shell.port == nil && shellHost != bundledHost }
        return shellScheme == "https" && (port == 0 ? 443 : port) == (shell.port ?? 443)
    }

    /// `text` (an address a page, a link or a QR code gave) as this build opens it: an address on the hosted origin
    /// (`hosted`) becomes the same page of the shell inside the app (`shell`), path, query and fragment kept, so a
    /// pairing link or a sign-in made for https://app.ovis.sh never loads from the network. Anything else, and
    /// everything in a build whose shell is the hosted origin, is as it was.
    public static func shellForm(_ text: String, hosted: URL?, shell: URL?) -> String {
        moved(text, from: hosted, to: shell)
    }

    /// The other way round, for the app's own pages (app/web), which name the shell by the hosted origin on both
    /// platforms: a key the app saved on the shell inside the app, as an address on the hosted origin.
    public static func hostedForm(_ text: String, hosted: URL?, shell: URL?) -> String {
        moved(text, from: shell, to: hosted)
    }

    private static func moved(_ text: String, from: URL?, to: URL?) -> String {
        guard let from, let to, !sameOrigin(from, to), let url = URL(string: text), sameOrigin(url, from),
              let parts = URLComponents(string: text), let origin = originText(to) else { return text }
        return origin + parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?" + $0 } ?? "") + (parts.percentEncodedFragment.map { "#" + $0 } ?? "")
    }

    private static func originText(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        return "\(scheme)://\(host.contains(":") ? "[\(host)]" : host)\(url.port.map { ":\($0)" } ?? "")"
    }

    /// The address to load instead of `url`, which a page of the shell inside the app is going to in the main frame,
    /// or nil to let it go: the hosted origin's twin of a page (a link written for https://app.ovis.sh) is that page
    /// inside the app, and a PC's scope named without its slash gets it, as the hosted app's host redirects it
    /// (scripts/shell-build.ts shellRedirects), so what the page names relative to itself stays within the scope.
    public static func shellNavigation(_ url: URL, hosted: URL?, shell: URL?) -> URL? {
        guard let shell, !sameOrigin(hosted, shell) else { return nil }
        let text = shellForm(url.absoluteString, hosted: hosted, shell: shell)
        guard let moved = URL(string: text), sameOrigin(moved, shell), var parts = URLComponents(string: text) else { return nil }
        let segments = parts.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false)
        if segments.count == 3, segments[0].isEmpty, segments[1] == "s", !segments[2].isEmpty { parts.percentEncodedPath += "/" }
        guard let next = parts.url, next.absoluteString != url.absoluteString else { return nil }
        return next
    }

    /// The script the app runs at the start of every main-frame document in a build that serves the shell itself:
    /// on a page of the shell (`shell`) it sets `window.__ovisAppShell = { bundled: true, platform: "ios", appVersion,
    /// build }`, the client's word that its copy is the app's (no service worker, no reload for a newer copy, the
    /// "Update the app" screen). On any other page it sets nothing: a PC's own page is that PC's copy, and the app's
    /// own pages and the demo are not the shell. The object grants nothing; what a page may ask is decided by where it
    /// was loaded from. Nil where nothing is the shell inside the app.
    public static func appShellScript(shell: URL?, version: String, build: Int) -> String? {
        guard let shell, shell.scheme?.lowercased() == appScheme, let host = shell.host?.lowercased(), !host.isEmpty, host != bundledHost,
              let data = try? JSONSerialization.data(withJSONObject: ["bundled": true, "platform": "ios", "appVersion": version, "build": build], options: [.sortedKeys]),
              let value = String(data: data, encoding: .utf8),
              let at = try? JSONSerialization.data(withJSONObject: [host], options: []), let hosts = String(data: at, encoding: .utf8) else { return nil }
        // JSON is not all JavaScript: U+2028 and U+2029 end a line there
        let literal = value.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return "(() => { if (location.protocol !== \"\(appScheme):\" || location.host !== \(hosts)[0]) return; "
            + "Object.defineProperty(window, \"__ovisAppShell\", { value: Object.freeze(\(literal)), enumerable: true }); })();"
    }

    /// What the app keeps of the PCs it saved once its shell moved inside the app: `saved`, `names`, `ids`, `current`
    /// and `last` without what was tied to the hosted origin (`hosted`), which no longer opens: the hosted app itself
    /// and every relay PC's scope there, whose sign-in and pairing keys are the hosted origin's own storage. A PC
    /// opened at its own address (a Tailscale or home network address, any other, an SSH PC's on this phone) keeps
    /// its page, its cookie and its place. `dead`: what was taken out, in its order, for the caller to set aside.
    public static func withoutHosted(saved: [String], names: [String: String], ids: [String: String], current: String?, last: String?, hosted: URL?)
        -> (saved: [String], names: [String: String], ids: [String: String], current: String?, last: String?, dead: [String]) {
        let tied = { (key: String) in sameOrigin(URL(string: key), hosted) }
        var dead = saved.filter(tied)
        for key in [current, last].compactMap({ $0 }) where tied(key) && !dead.contains(key) { dead.append(key) }
        return (saved.filter { !tied($0) }, names.filter { !tied($0.key) }, ids.filter { !tied($0.key) },
                current.flatMap { tied($0) ? nil : $0 }, last.flatMap { tied($0) ? nil : $0 }, dead)
    }

    /// The words of the screen an update to a build with the shell inside the app shows once, to a phone that had
    /// signed in or paired a PC on the hosted origin: what happened and what to do. `languages`: the phone's, the
    /// first decides (Korean, Japanese, Chinese, else English). `kept`: PCs opened at their own address are still
    /// there, which one more line says.
    public static func movedNotice(languages: [String], kept: Bool) -> (title: String, body: String, button: String) {
        let first = languages.first?.lowercased() ?? ""
        let words: (title: String, reset: String, pair: String, kept: String, button: String)
        if first.hasPrefix("ko") {
            words = ("다시 로그인하면 PC가 돌아와요", "이번 업데이트로 이 휴대폰이 로그아웃되고, 페어링한 PC가 초기화됐어요.",
                     "계정 없이 QR 코드나 링크로 페어링한 PC는 다시 페어링해야 해요.", "주소, Tailscale, SSH로 여는 PC는 그대로 있어요.", "다시 로그인")
        } else if first.hasPrefix("ja") {
            words = ("もう一度サインインすると PC が戻ります", "今回のアップデートで、このスマートフォンはサインアウトされ、ペアリングした PC がリセットされました。",
                     "アカウントなしで QR コードやリンクからペアリングした PC は、もう一度ペアリングが必要です。", "アドレス、Tailscale、SSH で開く PC はそのまま残っています。", "もう一度サインイン")
        } else if first.hasPrefix("zh") {
            words = ("重新登录即可找回你的电脑", "这次更新让这部手机退出了登录，并重置了已配对的电脑。",
                     "未使用账号、通过二维码或链接配对的电脑需要重新配对。", "通过地址、Tailscale 或 SSH 打开的电脑仍然保留。", "重新登录")
        } else {
            words = ("Sign in again to get your PCs back", "This update signed this phone out and reset the PCs paired on it.",
                     "A PC paired without an account, by a QR code or a link, needs pairing again.", "The PCs you open by an address, Tailscale or SSH are still here.", "Sign in again")
        }
        return (words.title, [words.reset, words.pair].joined(separator: "\n\n") + (kept ? "\n\n" + words.kept : ""), words.button)
    }
}

/// What the app answers a request to the shell inside the app with (ShellHost.swift), as the hosted app's host
/// answers the same path (scripts/shell-build.ts: shellRedirects, shellHeaders): the one page under every PC's scope,
/// the render host and the manifest there, a file by its own path, and nothing where the host has no file to give.
public enum ShellRoute: Equatable {
    /// index.html, with the shell's policy.
    case page
    /// render.html (`/s/<id>/~render`), with the render host's own policy and never the shell's.
    case render
    /// The file at this path within the shell's folder, with the shell's policy; `orPage`: the page where the folder
    /// has no such file, as the hosted app's host answers a path it lacks (a single-page app), never under `assets/`.
    case file(String, orPage: Bool)
    case missing

    /// The route of a request's path as its URL carries it (percent-encoded). A path that would not load as written
    /// is missing: an escape, a `\\`, an empty, `.` or `..` segment, or a character no file of the shell has.
    public static func route(_ path: String) -> ShellRoute {
        if path.isEmpty || path == "/" { return .page }
        guard path.hasPrefix("/"), path.utf8.allSatisfy({ pathByte($0) }) else { return .missing }
        var segments = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        // a folder named with its slash
        if segments.last == "" { segments.removeLast() }
        guard !segments.isEmpty, !segments.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return .missing }
        if segments[0] == "s" {
            // /s alone names no PC
            guard segments.count >= 2 else { return .missing }
            let rest = Array(segments.dropFirst(2))
            if rest == ["~render"] { return path.hasSuffix("/") ? .missing : .render }
            if rest == ["manifest.webmanifest"] { return .file("manifest.webmanifest", orPage: false) }
            // no service worker in the app: its web view has none
            if rest == ["sw.js"] { return .missing }
            return .page
        }
        if segments == ["index.html"] { return .page }
        // what the hosted app's host keeps to itself or serves for a browser alone: its rules, the worker, the app
        // links' files; and the render host's file under any path but a PC's, where it would get the shell's policy
        if segments[0].hasPrefix("_") || segments[0].hasPrefix(".") || segments == ["sw.js"] || segments == ["render.html"] { return .missing }
        // a hashed file the folder lacks is missing, never the page under a script's or a stylesheet's address
        let asset = segments[0] == "assets"
        if path.hasSuffix("/"), !asset { return .page }
        return .file(segments.joined(separator: "/"), orPage: !asset)
    }

    private static func pathByte(_ byte: UInt8) -> Bool {
        (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte) || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte)
            || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) || "/._~-@+".utf8.contains(byte)
    }

    /// The Content-Type of a file of the shell by its extension. A module script and a WebAssembly module load only
    /// under their own types.
    public static func contentType(_ name: String) -> String {
        let file = name.split(separator: "/").last ?? ""
        guard let dot = file.lastIndex(of: "."), dot != file.startIndex else { return "application/octet-stream" }
        return types[file[file.index(after: dot)...].lowercased()] ?? "application/octet-stream"
    }

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "json": "application/json", "map": "application/json",
        "webmanifest": "application/manifest+json", "wasm": "application/wasm", "txt": "text/plain; charset=utf-8",
        "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
        "webp": "image/webp", "avif": "image/avif", "ico": "image/x-icon",
        "woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf", "otf": "font/otf",
        "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "m4a": "audio/mp4", "mp4": "video/mp4", "webm": "video/webm"
    ]

    /// The two policies the hosted app's host sends, as the build read them from the carried copy's own `_headers`
    /// and wrote them beside it (shell-policy.json, app/scripts/bundled-shell.ts: `page` for every answer, `render`
    /// for the render host alone), or nil when either is missing, empty, or could start another header, or the render
    /// host's takes no origin away (`sandbox`): a shell without its policies is not served.
    public static func policies(_ data: Data?) -> (shell: String, render: String)? {
        guard let data, let read = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let shell = read["page"] as? String, let render = read["render"] as? String,
              headerValue(shell), headerValue(render), render.split(separator: ";").contains(where: { $0.trimmingCharacters(in: .whitespaces).split(separator: " ").first == "sandbox" }) else { return nil }
        return (shell, render)
    }

    private static func headerValue(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespaces).isEmpty && text.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value < 0x7f }
    }
}
