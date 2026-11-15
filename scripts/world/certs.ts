/** The world's test CA and one leaf for the names its TLS proxy answers for (openssl on this PC, 3 days). */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function openssl(args: readonly string[], cwd: string): void {
  const ran = Bun.spawnSync(["openssl", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(`openssl ${args[0]}: ${ran.stderr.toString().trim()}`);
}

/**
 * Makes `dir`/{ca.pem,cert.pem,key.pem}; returns the CA's path. The folder is its user's alone (0700) and both keys
 * are 0600: the leaf names the world's origins, M2's real host names among them. The TLS proxy (caddy, root in its
 * container) still reads them; the machines get ca.pem alone, mounted as a file (0644).
 */
export function makeCerts(dir: string, names: readonly string[]): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (!existsSync(join(dir, "cert.pem"))) {
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3", "-subj", "/CN=Ovis test world CA", "-keyout", "ca.key", "-out", "ca.pem"], dir);
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=world.test", "-keyout", "key.pem", "-out", "leaf.csr"], dir);
    writeFileSync(join(dir, "leaf.ext"), `subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
    openssl(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "3", "-extfile", "leaf.ext", "-out", "cert.pem"], dir);
    for (const file of ["ca.pem", "cert.pem"]) chmodSync(join(dir, file), 0o644);
    for (const file of ["ca.key", "key.pem"]) chmodSync(join(dir, file), 0o600);
  }
  return join(dir, "ca.pem");
}
