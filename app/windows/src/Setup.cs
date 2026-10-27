using System;
using System.Collections.Generic;
using System.Linq;
using System.Web.Script.Serialization;

namespace Ovis
{
    internal enum Phase
    {
        Checking,
        NotInstalled,
        Working,
        Failed,
        Installed,
        /// <summary>The Ovis server is older than this app, under the old id, or of a version nobody can read.</summary>
        Outdated,
        /// <summary>The Ovis server needs an update, and this herdr is older than the server needs.</summary>
        HerdrTooOld,
    }

    internal enum UpdateReason
    {
        None,
        /// <summary>Installed under devswha.herdr-web-ui (0.4.13 and older): install.ps1 moves it to the new id.</summary>
        LegacyId,
        Older,
        /// <summary>Neither the server's status nor herdr names a version.</summary>
        VersionUnknown,
    }

    internal sealed class Plugin
    {
        public string Id;
        public string Root;
        /// <summary>The version of herdr's checkout, as herdr lists it; null when herdr does not say.</summary>
        public string Version;
        public string MinHerdr;
        /// <summary>A plugin herdr says it did not install from GitHub (a linked checkout): a reinstall would be refused.</summary>
        public bool Linked;
    }

    /// <summary>What the window shows for what is on this PC; no process runs here, so tests read it all.</summary>
    internal static class Setup
    {
        /// <summary>The oldest herdr install.ps1 takes.</summary>
        public static readonly Version InstallerMinHerdr = new Version(0, 9, 0);

        /// <summary>"0.4.19", "v0.4.19" or "herdr 0.9.3-preview" as X.Y.Z; null for anything else.</summary>
        public static Version ParseVersion(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return null;
            var word = text.Trim().Split(' ').Last();
            if (word.StartsWith("v")) word = word.Substring(1);
            var end = word.IndexOfAny(new[] { '-', '+' });
            if (end >= 0) word = word.Substring(0, end);
            Version version;
            if (!System.Version.TryParse(word, out version) || version.Build < 0 || version.Revision >= 0) return null;
            return version;
        }

        /// <summary>
        /// The plugin in `herdr plugin list --json`, under its id or, for releases up to 0.4.13, the old one; null when
        /// neither is listed or the JSON is not what herdr prints.
        /// </summary>
        public static Plugin ParsePlugin(string json)
        {
            try
            {
                var root = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                object answer, list;
                var plugins = root != null && root.TryGetValue("result", out answer) && answer is Dictionary<string, object> && ((Dictionary<string, object>)answer).TryGetValue("plugins", out list)
                    ? list as System.Collections.ArrayList
                    : null;
                if (plugins == null) return null;
                var listed = plugins.OfType<Dictionary<string, object>>().ToList();
                foreach (var id in new[] { Links.PluginId, Links.LegacyPluginId })
                {
                    var found = listed.FirstOrDefault(p => Text(p, "plugin_id") == id);
                    if (found == null || Text(found, "plugin_root") == null) continue;
                    object source;
                    var kind = found.TryGetValue("source", out source) && source is Dictionary<string, object> ? Text((Dictionary<string, object>)source, "kind") : null;
                    return new Plugin
                    {
                        Id = id,
                        Root = Text(found, "plugin_root"),
                        Version = Text(found, "version"),
                        MinHerdr = Text(found, "min_herdr_version"),
                        Linked = kind != null && kind != "github",
                    };
                }
            }
            catch (Exception exception) when (exception is ArgumentException || exception is InvalidOperationException || exception is KeyNotFoundException || exception is InvalidCastException)
            {
                return null; // not the JSON this herdr is expected to print: treated as no plugin
            }
            return null;
        }

        /// <summary>The `version: X.Y.Z` line of `plugin.ts status`: the release that runs, which may be newer than herdr's checkout.</summary>
        public static string StatusVersion(string output)
        {
            var line = (output ?? "").Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.StartsWith("version: "));
            return line == null ? null : line.Substring("version: ".Length).Trim();
        }

        /// <summary>`current_version` of GET /api/updates: the package.json of the build the answering server runs.</summary>
        public static string UpdatesVersion(string json)
        {
            try
            {
                var root = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                return root == null ? null : Text(root, "current_version");
            }
            catch (Exception exception) when (exception is ArgumentException || exception is InvalidOperationException)
            {
                return null;
            }
        }

        /// <summary>
        /// The server's version and whether it is the one that runs: what the answering server reports (GET
        /// /api/updates), else the status line (the release the next start runs), else herdr's list, which names the
        /// checkout as first installed: Settings → Updates may run a newer release since, so that one is a lower bound.
        /// </summary>
        public static Version ServerVersion(Plugin plugin, string runningVersion, string statusVersion, out bool exact)
        {
            var known = ParseVersion(runningVersion) ?? ParseVersion(statusVersion);
            exact = known != null;
            return known ?? ParseVersion(plugin == null ? null : plugin.Version);
        }

        /// <summary>
        /// Why the server needs an update. A stopped server known only by herdr's lower bound is started first, as it
        /// may have updated itself; once it answers, its own version decides. An app without a version (a local build)
        /// asks only the old id to move.
        /// </summary>
        public static UpdateReason Reason(Plugin plugin, string runningVersion, string statusVersion, bool running, Version app)
        {
            if (plugin == null) return UpdateReason.None;
            if (plugin.Id == Links.LegacyPluginId) return UpdateReason.LegacyId;
            if (app == null || plugin.Linked) return UpdateReason.None;
            bool exact;
            var server = ServerVersion(plugin, runningVersion, statusVersion, out exact);
            if (server == null) return UpdateReason.VersionUnknown;
            if (server >= app || (!exact && !running)) return UpdateReason.None;
            return UpdateReason.Older;
        }

        /// <summary>The herdr the server needs: what the plugin asks for, and never less than install.ps1 takes.</summary>
        public static Version RequiredHerdr(Plugin plugin)
        {
            var asked = plugin == null ? null : ParseVersion(plugin.MinHerdr);
            return asked != null && asked > InstallerMinHerdr ? asked : InstallerMinHerdr;
        }

        /// <summary>The screen: herdr is read only when an update is due, and a herdr whose version is unreadable is let through.</summary>
        public static Phase Choose(Plugin plugin, UpdateReason reason, Version herdr)
        {
            if (plugin == null) return Phase.NotInstalled;
            if (reason == UpdateReason.None) return Phase.Installed;
            return herdr != null && herdr < RequiredHerdr(plugin) ? Phase.HerdrTooOld : Phase.Outdated;
        }

        public static string UpdateMessage(UpdateReason reason, Plugin plugin, string runningVersion, string statusVersion, Version app)
        {
            bool exact;
            var server = ServerVersion(plugin, runningVersion, statusVersion, out exact);
            var target = app == null ? Lang.L("the latest version", "최신 버전") : Short(app);
            var keeps = Lang.L(" herdr, your agents and your settings stay.", " herdr, 에이전트, 설정은 그대로 남습니다.");
            switch (reason)
            {
                case UpdateReason.LegacyId:
                    return (server == null
                        ? Lang.L("This PC has an old Ovis server, from before its new name. Update it to " + target + " or newer.", "이 PC에 예전 이름으로 설치된 옛 Ovis 서버가 있습니다. " + target + " 이상으로 업데이트하세요.")
                        : Lang.L("This PC has an old Ovis server (" + Short(server) + "), from before its new name. Update it to " + target + " or newer.", "이 PC에 예전 이름으로 설치된 옛 Ovis 서버(" + Short(server) + ")가 있습니다. " + target + " 이상으로 업데이트하세요.")) + keeps;
                case UpdateReason.Older:
                    // known only by herdr's list, the server may have updated itself since: say what herdr knows
                    return (exact
                        ? Lang.L("This PC has Ovis server " + Short(server) + ", older than this app (" + target + "). Update it to " + target + " or newer.",
                                 "이 PC의 Ovis 서버(" + Short(server) + ")가 이 앱(" + target + ")보다 오래됐습니다. " + target + " 이상으로 업데이트하세요.")
                        : Lang.L("This PC's Ovis server was installed at " + Short(server) + ", older than this app (" + target + "). Update it to " + target + " or newer so they match.",
                                 "이 PC의 Ovis 서버는 " + Short(server) + "로 설치됐고, 이 앱(" + target + ")보다 오래됐습니다. 서로 맞도록 " + target + " 이상으로 업데이트하세요.")) + keeps;
                case UpdateReason.VersionUnknown:
                    return Lang.L("Ovis cannot read which version of the Ovis server this PC has. Update it to " + target + " or newer so it matches this app.",
                                  "이 PC에 있는 Ovis 서버의 버전을 읽지 못했습니다. 이 앱과 맞도록 " + target + " 이상으로 업데이트하세요.") + keeps;
                default:
                    return "";
            }
        }

        /// <summary>
        /// The tag the update installs: the newest release `git ls-remote --tags` lists, never older than this app. A
        /// server that updated itself past this app keeps its version: reinstalled older, it would run the older
        /// checkout, since its installed release is tied to the checkout it replaced. Without the list (null) there is
        /// no tag: the app's own could be older than what runs.
        /// </summary>
        public static string UpdateTag(string lsRemote, Version app)
        {
            if (lsRemote == null) return null;
            var newest = app;
            foreach (var line in (lsRemote ?? "").Split('\n'))
            {
                var at = line.LastIndexOf("refs/tags/v", StringComparison.Ordinal);
                if (at < 0) continue;
                var name = line.Substring(at + "refs/tags/".Length).Trim();
                if (name.IndexOfAny(new[] { '-', '+' }) >= 0) continue;
                var version = ParseVersion(name);
                if (version != null && (newest == null || version > newest)) newest = version;
            }
            return newest == null ? null : "v" + newest.ToString(3);
        }

        public static string HerdrMessage(Plugin plugin, Version herdr)
        {
            var needed = Short(RequiredHerdr(plugin));
            return Lang.L("This PC has herdr " + Short(herdr) + ", and the Ovis server needs herdr " + needed + " or newer. Update herdr (run herdr update in a terminal), then check again.",
                          "이 PC의 herdr는 " + Short(herdr) + "이고, Ovis 서버에는 herdr " + needed + " 이상이 필요합니다. 터미널에서 herdr update를 실행해 herdr를 업데이트한 뒤 다시 확인해 주세요.");
        }

        /// <summary>This app's version, X.Y.Z; null for a build without one (0.0.0).</summary>
        public static Version AppVersion(Version assembly)
        {
            if (assembly == null || (assembly.Major == 0 && assembly.Minor == 0 && assembly.Build <= 0)) return null;
            return new Version(assembly.Major, assembly.Minor, Math.Max(0, assembly.Build));
        }

        private static string Short(Version version)
        {
            return version == null ? "?" : version.ToString(3);
        }

        private static string Text(Dictionary<string, object> map, string key)
        {
            object value;
            return map.TryGetValue(key, out value) ? value as string : null;
        }
    }
}
