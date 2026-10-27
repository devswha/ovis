using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;

namespace Ovis
{
    /// <summary>
    /// Which screen the app shows for what a PC has, and what it reads to choose. Run Ovis.Tests.exe: it prints each
    /// case and exits 1 when one fails. The herdr answers are shaped as herdr 0.9.3 and 0.9.5 print them.
    /// </summary>
    internal static class SetupTests
    {
        private static readonly Version App = new Version(0, 4, 19);
        private static int failures;

        private static int Main()
        {
            // Lang reads the culture once: the wording checked below is the English one
            Thread.CurrentThread.CurrentUICulture = CultureInfo.GetCultureInfo("en-US");
            var cases = new List<KeyValuePair<string, Action>>
            {
                Case("a fresh PC, with no herdr or no plugin, gets Install", () =>
                {
                    Equal(Phase.NotInstalled, Setup.Choose(null, Setup.Reason(null, null, App), null));
                    Equal(Phase.NotInstalled, Setup.Choose(Setup.ParsePlugin(List()), UpdateReason.None, null));
                }),
                Case("home-window as found: 0.3.45 under the old id, herdr 0.9.3 stopped, gets Update", () =>
                {
                    var plugin = Setup.ParsePlugin(List(Entry(Links.LegacyPluginId, "0.3.45")));
                    var reason = Setup.Reason(plugin, null, App);
                    Equal(UpdateReason.LegacyId, reason);
                    Equal(Phase.Outdated, Setup.Choose(plugin, reason, new Version(0, 9, 3)));
                    var message = Setup.UpdateMessage(reason, plugin, null, App);
                    Contains(message, "old Ovis server (0.3.45)");
                    Contains(message, "Update it to 0.4.19");
                }),
                Case("the old id needs the move whatever its version, and in a build without a version", () =>
                {
                    var plugin = Setup.ParsePlugin(List(Entry(Links.LegacyPluginId, "0.4.13")));
                    Equal(UpdateReason.LegacyId, Setup.Reason(plugin, "0.4.30", App));
                    Equal(UpdateReason.LegacyId, Setup.Reason(plugin, null, null));
                    Contains(Setup.UpdateMessage(UpdateReason.LegacyId, plugin, null, null), "Update it to the latest version");
                }),
                Case("a server older than the app gets Update, naming both versions", () =>
                {
                    var plugin = Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.15")));
                    var reason = Setup.Reason(plugin, null, App);
                    Equal(UpdateReason.Older, reason);
                    Equal(Phase.Outdated, Setup.Choose(plugin, reason, new Version(0, 9, 5)));
                    Contains(Setup.UpdateMessage(reason, plugin, null, App), "Ovis server 0.4.15, older than this app (0.4.19)");
                }),
                Case("a server Settings > Updates brought up to date is current, though herdr lists its first version", () =>
                {
                    var plugin = Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.15")));
                    Equal(UpdateReason.None, Setup.Reason(plugin, "0.4.19", App));
                    Equal(UpdateReason.None, Setup.Reason(plugin, "0.4.25", App));
                    Equal(UpdateReason.Older, Setup.Reason(Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.19"))), "0.4.18", App));
                }),
                Case("a current server, running or stopped, gets the Installed screen (Start, or Restart)", () =>
                {
                    foreach (var version in new[] { "0.4.19", "0.4.20" })
                    {
                        var plugin = Setup.ParsePlugin(List(Entry(Links.PluginId, version)));
                        Equal(Phase.Installed, Setup.Choose(plugin, Setup.Reason(plugin, null, App), null));
                    }
                }),
                Case("a server whose version nobody reports gets Update, saying it cannot be read", () =>
                {
                    var plugin = Setup.ParsePlugin(List(Entry(Links.PluginId, null)));
                    Equal(null, plugin.Version);
                    var reason = Setup.Reason(plugin, null, App);
                    Equal(UpdateReason.VersionUnknown, reason);
                    Equal(Phase.Outdated, Setup.Choose(plugin, reason, null));
                    Contains(Setup.UpdateMessage(reason, plugin, null, App), "cannot read which version");
                    Equal(UpdateReason.VersionUnknown, Setup.Reason(Setup.ParsePlugin(List(Entry(Links.PluginId, "unknown"))), "", App));
                }),
                Case("a linked checkout, or an app built without a version, is never offered a reinstall", () =>
                {
                    Equal(UpdateReason.None, Setup.Reason(Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.1", "local"))), null, App));
                    Equal(UpdateReason.None, Setup.Reason(Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.1"))), null, null));
                }),
                Case("a herdr older than the server needs gets the herdr screen, naming both", () =>
                {
                    var legacy = Setup.ParsePlugin(List(Entry(Links.LegacyPluginId, "0.3.45")));
                    Equal(Phase.HerdrTooOld, Setup.Choose(legacy, UpdateReason.LegacyId, new Version(0, 8, 9)));
                    var asking = Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.1", "github", "0.9.4")));
                    Equal(Phase.HerdrTooOld, Setup.Choose(asking, UpdateReason.Older, new Version(0, 9, 3)));
                    Equal(Phase.Outdated, Setup.Choose(asking, UpdateReason.Older, new Version(0, 9, 4)));
                    Equal(Phase.Outdated, Setup.Choose(asking, UpdateReason.Older, null));
                    Contains(Setup.HerdrMessage(asking, new Version(0, 9, 3)), "herdr 0.9.3, and the Ovis server needs herdr 0.9.4 or newer");
                }),
                Case("herdr's list: the new id wins over the old, and what is not herdr's JSON is no plugin", () =>
                {
                    var both = Setup.ParsePlugin(List(Entry(Links.LegacyPluginId, "0.3.45"), Entry(Links.PluginId, "0.4.19")));
                    Equal(Links.PluginId, both.Id);
                    Equal(@"C:\Users\u\AppData\Roaming\herdr\plugins\" + Links.PluginId, both.Root);
                    Equal("0.9.0", both.MinHerdr);
                    Equal(false, both.Linked);
                    Equal(null, Setup.ParsePlugin("herdr: unknown command"));
                    Equal(null, Setup.ParsePlugin("{\"result\":{\"plugins\":[{\"plugin_id\":\"devswha.ovis\"}]}}"));
                    Equal(null, Setup.ParsePlugin(List(Entry("someone.else", "1.0.0"))));
                }),
                Case("plugin.ts status: the version line, which releases before it do not print", () =>
                {
                    Equal("0.4.19", Setup.StatusVersion("running http://127.0.0.1:7317 (pid 4)\r\nversion: 0.4.19\r\nconfig: none\r\n"));
                    Equal(null, Setup.StatusVersion("down http://127.0.0.1:7317\nconfig: none (settings go in C:\\x\\env)\n"));
                    Equal(null, Setup.StatusVersion(""));
                }),
                Case("versions: X.Y.Z from herdr's, a tag's or a preview's spelling, and nothing else", () =>
                {
                    Equal(new Version(0, 9, 3), Setup.ParseVersion("herdr 0.9.3"));
                    Equal(new Version(0, 4, 19), Setup.ParseVersion("v0.4.19"));
                    Equal(new Version(0, 9, 5), Setup.ParseVersion("0.9.5-preview.2"));
                    Equal(null, Setup.ParseVersion("0.4"));
                    Equal(null, Setup.ParseVersion("1.2.3.4"));
                    Equal(null, Setup.ParseVersion(null));
                    Equal(new Version(0, 4, 19), Setup.AppVersion(new Version(0, 4, 19, 0)));
                    Equal(null, Setup.AppVersion(new Version(0, 0, 0, 0)));
                }),
            };
            foreach (var test in cases)
            {
                try
                {
                    test.Value();
                    Console.WriteLine("ok   " + test.Key);
                }
                catch (Exception exception)
                {
                    failures++;
                    Console.WriteLine("FAIL " + test.Key + Environment.NewLine + "     " + exception.Message);
                }
            }
            Console.WriteLine(failures == 0 ? cases.Count + " passed" : failures + " of " + cases.Count + " failed");
            return failures == 0 ? 0 : 1;
        }

        private static KeyValuePair<string, Action> Case(string name, Action body)
        {
            return new KeyValuePair<string, Action>(name, body);
        }

        /// <summary>One plugin as herdr's list prints it; a null version leaves the field out.</summary>
        private static string Entry(string id, string version, string kind = "github", string minHerdr = "0.9.0")
        {
            var root = (@"C:\Users\u\AppData\Roaming\herdr\plugins\" + id).Replace(@"\", @"\\");
            return "{\"enabled\":true,\"manifest_path\":\"" + root + "\\\\herdr-plugin.toml\",\"min_herdr_version\":\"" + minHerdr + "\",\"name\":\"Ovis\",\"platforms\":[\"linux\",\"macos\",\"windows\"],\"plugin_id\":\"" + id +
                   "\",\"plugin_root\":\"" + root + "\",\"source\":{\"kind\":\"" + kind + "\",\"owner\":\"devswha\",\"repo\":\"ovis\",\"requested_ref\":\"v" + (version ?? "0.4.14") + "\"}" +
                   (version == null ? "" : ",\"version\":\"" + version + "\"") + ",\"actions\":[]}";
        }

        private static string List(params string[] entries)
        {
            return "{\"id\":\"cli:plugin\",\"result\":{\"plugins\":[" + string.Join(",", entries) + "]}}";
        }

        private static void Equal<T>(T expected, T actual)
        {
            if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception("expected " + Show(expected) + ", got " + Show(actual));
        }

        private static void Contains(string text, string part)
        {
            if (text == null || !text.Contains(part)) throw new Exception("expected \"" + part + "\" in \"" + text + "\"");
        }

        private static string Show(object value)
        {
            return value == null ? "null" : value.ToString();
        }
    }
}
