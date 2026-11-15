import { describe, expect, it } from "bun:test";
import qrcode from "qrcode-generator";
import { lastQrLink, readQr } from "./qr.ts";

const draw = (text: string) => { const code = qrcode(0, "M"); code.addData(text); code.make(); return code.createASCII(1, 1); };

describe("the terminal's QR code, read back offline", () => {
  it("reads links of every size the terminal draws, as the encoder drew them", () => {
    const offer = "x".repeat(40);
    for (const text of ["https://a.test/", `https://home-server.tail1e211e.ts.net:17541/s/0123456789abcdef0123456789abcdef/#offer=${offer}`,
      `https://app.ovis.sh/s/${"f".repeat(32)}/#offer=${"A1b2-_".repeat(60)}`, "https://account.world.test:9443/link?code=K7QF-9XWD"]) {
      expect(readQr(draw(text))).toBe(text);
    }
  });

  it("reads pairing links of every length a machine prints, whatever a wrong mask reads on the way", () => {
    for (let n = 0; n < 40; n++) {
      const offer = Array.from({ length: 140 + n * 7 }, (_, i) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[(i * 31 + n * 17) % 64]).join("");
      const link = `https://home-server.tail1e211e.ts.net:17541/s/${(n * 7919).toString(16).padStart(32, "0")}/#offer=${offer}`;
      expect(readQr(draw(link))).toBe(link);
    }
  });

  it("finds the last drawing in a recording with other lines around it", () => {
    const first = "https://first.test/s/1/#offer=a";
    const last = "https://second.test/s/2/#offer=b";
    const recording = `Signed in.\r\n${draw(first).replace(/\n/g, "\r\n")}\r\nNo code to type this time.\r\n${draw(last).replace(/\n/g, "\r\n")}\r\nThe QR code expires in 10 minutes.\r\n`;
    expect(lastQrLink(recording)).toBe(last);
  });

  it("reads a drawing on the terminal's other screen, whose first line carries escape sequences", () => {
    const link = "https://app.world.test:9445/s/0123/#offer=abc";
    const recording = `Signed in.\r\n\x1b[?1049h\x1b[H\x1b[2J${draw(link).replace(/\n/g, "\r\n")}\r\nNo code to type this time.\r\n`;
    expect(lastQrLink(recording)).toBe(link);
  });

  it("gives null, never a guess, for a drawing that is damaged or no QR code at all", () => {
    const lines = draw("https://a.test/link").split("\n");
    const middle = Math.floor(lines.length / 2);
    lines[middle] = lines[middle]!.slice(0, 6) + (lines[middle]![6] === "█" ? " " : "█") + lines[middle]!.slice(7);
    expect(readQr(lines.join("\n"))).toBeNull();
    expect(lastQrLink("no code here\n████████████████████████\n")).toBeNull();
  });
});
