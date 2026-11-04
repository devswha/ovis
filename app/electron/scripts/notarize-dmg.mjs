/**
 * electron-builder's artifactBuildCompleted hook (electron-builder.yml): notarizes and staples the
 * macOS dmg, so it opens without a Gatekeeper warning even offline. electron-builder signs the app
 * (hardened runtime, build/entitlements.mac*.plist), notarizes and staples the app, and signs the
 * dmg (dmg.sign); only the dmg's notarization is left to this hook. Plain JavaScript, so it loads
 * under whichever Node runs electron-builder.
 *
 * It runs when the dmg is signed and the notary key is set, the same variables electron-builder
 * notarizes the app with:
 *
 *   APPLE_API_KEY      path to an App Store Connect API key (.p8)
 *   APPLE_API_KEY_ID   its key ID
 *   APPLE_API_ISSUER   its issuer ID
 *
 * Signing takes electron-builder's own: CSC_LINK (a .p12, as a path or base64) with
 * CSC_KEY_PASSWORD, or CSC_NAME for a Developer ID Application identity already in a keychain.
 * Without an identity the build is unsigned and this hook does nothing; a notary key without a
 * signed dmg stops the build.
 */
import { execFile } from "node:child_process";

export const NOTARY_ENV = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];

/** @typedef {(file: string, args: string[]) => Promise<string>} Run */

/** @type {Run} */
function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

/**
 * @param {string} dmg
 * @param {{ env?: Record<string, string | undefined>, run?: Run, log?: (line: string) => void }} [options]
 * @returns {Promise<"notarized" | "skipped">}
 */
export async function notarizeDmg(dmg, options = {}) {
  const env = options.env ?? process.env;
  const exec = options.run ?? run;
  const log = options.log ?? ((line) => console.log(`  • ${line}`));
  const set = NOTARY_ENV.filter((name) => env[name]?.trim());
  if (set.length === 0) {
    log(`no notary key (${NOTARY_ENV.join(", ")}): ${dmg} is not notarized`);
    return "skipped";
  }
  if (set.length < NOTARY_ENV.length) throw new Error(`Notarizing needs all of ${NOTARY_ENV.join(", ")}; missing ${NOTARY_ENV.filter((name) => !set.includes(name)).join(", ")}`);
  try {
    await exec("codesign", ["--verify", "--strict", dmg]);
  } catch (error) {
    throw new Error(`${dmg} is not signed, so it cannot be notarized: set CSC_LINK or CSC_NAME to a Developer ID Application identity (${error instanceof Error ? error.message : error})`);
  }
  log(`notarizing ${dmg}`);
  const key = ["--key", env["APPLE_API_KEY"].trim(), "--key-id", env["APPLE_API_KEY_ID"].trim(), "--issuer", env["APPLE_API_ISSUER"].trim()];
  const submitted = JSON.parse(await exec("xcrun", ["notarytool", "submit", dmg, ...key, "--wait", "--output-format", "json"]));
  if (submitted.status !== "Accepted") {
    const details = submitted.id ? await exec("xcrun", ["notarytool", "log", submitted.id, ...key]).catch((error) => String(error)) : "";
    throw new Error(`Notarization of ${dmg} ended ${submitted.status ?? "without a status"}: ${submitted.message ?? ""}\n${details}`);
  }
  await exec("xcrun", ["stapler", "staple", dmg]);
  await exec("xcrun", ["stapler", "validate", dmg]);
  // what Gatekeeper asks of a downloaded dmg before it mounts it
  await exec("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", dmg]);
  log(`notarized and stapled ${dmg} (${submitted.id})`);
  return "notarized";
}

/** @param {{ file: string }} context */
export default async function artifactBuildCompleted(context) {
  if (context.file.endsWith(".dmg")) await notarizeDmg(context.file);
}
