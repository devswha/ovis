// Synthetic Claude-shaped process: a local transcript, screen-read menu and real OSC 7501 reports.
const fs = require("node:fs");
const [home, sessionId] = process.argv.slice(2);
process.title = "claude";
fs.mkdirSync(home + "/.claude/sessions", { recursive: true });
fs.writeFileSync(home + "/.claude/sessions/" + process.pid + ".json", JSON.stringify({
  pid: process.pid, sessionId, cwd: home,
  procStart: fs.readFileSync("/proc/self/stat", "utf8").split(") ").pop().split(" ")[19], kind: "interactive",
}));
let waiting = false;
let cursor = 0;
const choices = ["No, exit", "Yes, I trust this folder"];
const status = (state) => process.stdout.write("\x1b]7501;state=" + state + ":app=claude\x1b\\");
const draw = () => process.stdout.write("\x1b[2J\x1b[H" + (waiting ? [
  " Accessing workspace:", "", " Quick safety check: Is this a project you created or one you trust?", "",
  ...choices.map((choice, index) => " " + (index === cursor ? "\u276f" : " ") + " " + choice), "", " Enter to confirm \u00b7 Esc to cancel",
] : ["Fleet core agent answered.", "Waiting for the next instruction."]).join("\r\n"));
process.stdin.setRawMode(true);
process.stdin.resume();
fs.writeFileSync(home + "/inputs", "");
fs.writeFileSync(home + "/answers", "");
status("idle");
for (let i = 1; i <= 300; i++) process.stdout.write("HIST-" + String(i).padStart(3, "0") + "\r\n");
process.stdin.on("data", (bytes) => {
  const text = bytes.toString();
  fs.appendFileSync(home + "/inputs", JSON.stringify(text) + "\n");
  if (text === "r") { waiting = true; cursor = 0; process.stdout.write("\x1b[?1049h"); status("blocked"); draw(); }
  else if (text === "l") { process.stdout.write("CORE-RECOVERY-LIVE\r\n"); }
  else if (text === "w") { status("working"); }
  else if (text === "d") { status("done"); }
  else if (waiting) {
    if (text.includes("\x1b[B")) cursor = Math.min(1, cursor + 1);
    if (text.includes("\x1b[A")) cursor = Math.max(0, cursor - 1);
    if (text.includes("\r")) { fs.appendFileSync(home + "/answers", choices[cursor] + "\n"); waiting = false; status("idle"); }
    draw();
  } else process.stdout.write("RECEIVED:" + text + "\r\n");
});
process.stdout.on("resize", () => fs.appendFileSync(home + "/sizes", process.stdout.columns + "x" + process.stdout.rows + "\n"));
