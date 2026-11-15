/**
 * Checks that the fleet link's vectors cover its contract: parses the `<!-- contract:... -->` tables
 * of docs/fleet-link.md and the files in server/fleet/vectors/, prints one line per gap and exits 1,
 * or prints `CONTRACT COVERED`. records.json holds Noise records, not mux frames: it is checked
 * against the `records` table alone. Also checks the new frame types against FrameType in
 * shared/relay-mux.ts, so a type the public mux takes later cannot collide unnoticed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MUX_RECEIVE_RESERVATION_BYTES } from "../shared/relay-mux-engine.ts";
import { FrameType, MAX_FRAME_BYTES } from "../shared/relay-mux.ts";

const ROOT = join(import.meta.dir, "..");
const VECTORS = join(ROOT, "server", "fleet", "vectors");
const doc = readFileSync(join(ROOT, "docs", "fleet-link.md"), "utf8");

type Obj = Record<string, unknown>;
interface Case {
  file: string; name: string; frame: string; type: number | null; direction: string; context: Obj;
  parse?: Obj; refuse?: { kind?: string; code?: string; message?: string }; limit?: string; canonical?: boolean;
}
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const gaps: string[] = [];

function table(marker: string): string[][] {
  const lines = doc.split("\n");
  const at = lines.findIndex((line) => line.trim() === `<!-- contract:${marker} -->`);
  if (at < 0) { gaps.push(`MISSING table contract:${marker} in docs/fleet-link.md`); return []; }
  const rows: string[][] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("|")) { if (rows.length) break; continue; }
    // split on pipes not escaped as \|, then drop the code ticks of each cell
    const cells = line.slice(1, line.endsWith("|") ? -1 : undefined).split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|").replace(/`/g, ""));
    rows.push(cells);
  }
  return rows.slice(2);
}
const answer = (text: string): { kind: string; code: string } | null => {
  const match = /^(RESET|SESSION_ERROR) ([a-z_]+)$/.exec(text);
  return match ? { kind: match[1] === "RESET" ? "reset" : "session_error", code: match[2]! } : null;
};
function paths(value: unknown, prefix = ""): string[] {
  if (!isObj(value)) return prefix ? [prefix] : [];
  const keys = Object.keys(value);
  if (!keys.length) return prefix ? [prefix] : [];
  return keys.flatMap((key) => paths(value[key], prefix ? `${prefix}.${key}` : key));
}

const cases: Case[] = [];
const RECORDS_FILE = "records.json";
for (const file of readdirSync(VECTORS).filter((name) => name.endsWith(".json") && name !== RECORDS_FILE).sort()) {
  const data = JSON.parse(readFileSync(join(VECTORS, file), "utf8")) as Obj;
  for (const entry of (data["cases"] as Obj[] | undefined) ?? []) {
    const expected = isObj(entry["expect"]) ? entry["expect"] : {};
    cases.push({
      file, name: String(entry["name"]), frame: String(entry["frame"]), type: entry["type"] as number | null,
      direction: String(entry["direction"]), context: isObj(entry["context"]) ? entry["context"] : {},
      ...(isObj(expected["parse"]) ? { parse: expected["parse"] } : {}),
      ...(isObj(expected["refuse"]) ? { refuse: expected["refuse"] as Case["refuse"] } : {}),
      ...(typeof entry["limit"] === "string" ? { limit: entry["limit"] } : {}),
      ...(entry["canonical"] === false ? { canonical: false } : {}),
    });
  }
}
const accepted = cases.filter((entry) => entry.parse && !entry.refuse);
const hexType = (text: string) => (/^0x[0-9a-f]{2}$/.test(text) ? parseInt(text, 16) : NaN);
const inUse = Object.values(FrameType) as number[];

const frames = table("frames");
const contractFrames = new Map<string, number | null>();
for (const [typeText = "", name = "", isNew = "", , , , file = ""] of frames) {
  const type = typeText === "file" ? null : hexType(typeText);
  if (type !== null && Number.isNaN(type)) { gaps.push(`BAD frame row ${name}: type ${typeText}`); continue; }
  if (type !== null && [...contractFrames.values()].includes(type)) gaps.push(`BAD frame ${name}: type ${typeText} listed twice`);
  contractFrames.set(name, type);
  if (isNew === "yes") {
    if (type === null || type < 0x40 || type > 0x4f) gaps.push(`BAD frame ${name}: ${typeText} is outside the extension range 0x40-0x4f`);
    else if (inUse.includes(type)) gaps.push(`BAD frame ${name}: ${typeText} collides with a type in shared/relay-mux.ts`);
  } else if (isNew === "no" && (FrameType as Record<string, number>)[name] !== type) {
    gaps.push(`BAD frame ${name}: shared/relay-mux.ts has ${(FrameType as Record<string, number>)[name]}, the document ${typeText}`);
  }
  if (!accepted.some((entry) => entry.frame === name && entry.type === type && entry.file === file)) {
    gaps.push(`UNCOVERED frame ${name} (${typeText}): no accepted case in ${file}`);
  }
}

const fields = table("fields");
const documented = new Set(fields.map(([frame = "", field = ""]) => `${frame}.${field}`));
for (const [frame = "", field = ""] of fields) {
  if (!contractFrames.has(frame)) gaps.push(`BAD field ${frame}.${field}: ${frame} is not in the frames table`);
  if (!accepted.some((entry) => entry.frame === frame && paths(entry.parse).includes(field))) gaps.push(`UNCOVERED field ${frame}.${field}: no accepted ${frame} case carries it`);
}
for (const entry of accepted) {
  if (!contractFrames.has(entry.frame) || entry.canonical === false) continue;
  for (const path of paths(entry.parse)) {
    if (!documented.has(`${entry.frame}.${path}`)) gaps.push(`UNDOCUMENTED field ${entry.frame}.${path} in case ${entry.name}`);
  }
}

const limits = table("limits");
const limitNames = new Set<string>();
for (const [name = "", value = "", , answerText = ""] of limits) {
  limitNames.add(name);
  const wanted = answer(answerText);
  if (!wanted || !/^[0-9]+$/.test(value)) { gaps.push(`BAD limit row ${name}: ${value} / ${answerText}`); continue; }
  if (!cases.some((entry) => entry.limit === name && entry.refuse?.kind === wanted.kind && entry.refuse.code === wanted.code)) {
    gaps.push(`UNCOVERED limit ${name}: no case exceeding it is refused ${answerText}`);
  }
}
const limitValue = (name: string) => Number(limits.find(([row]) => row === name)?.[1]);
// every pipe's receive window is reserved as WS windows are, within the engine's per-session reservation
if (limitValue("pipe_window_bytes") * limitValue("max_pipe_streams") !== MUX_RECEIVE_RESERVATION_BYTES) gaps.push("BAD limit pipe_window_bytes: max_pipe_streams windows are not the engine's MUX_RECEIVE_RESERVATION_BYTES");
const overWindow = cases.find((entry) => entry.limit === "pipe_window_bytes");
if (overWindow?.context["received"] !== limitValue("pipe_window_bytes")) gaps.push("BAD limit pipe_window_bytes: the case exceeding it starts from another window");
if (limitValue("pipe_data_bytes") !== MAX_FRAME_BYTES - 8) gaps.push("BAD limit pipe_data_bytes: not max_frame_bytes minus the envelope");
const welcome = accepted.find((entry) => entry.frame === "WELCOME");
if ((welcome?.parse?.["limits"] as Obj | undefined)?.["max_pipe_streams"] !== limitValue("max_pipe_streams")) gaps.push("BAD limit max_pipe_streams: WELCOME's vector names another value");
for (const entry of cases) if (entry.limit !== undefined && !limitNames.has(entry.limit)) gaps.push(`BAD case ${entry.name}: unknown limit ${entry.limit}`);

const neverFrames = new Set<string>();
for (const [marker, direction] of [["never-from-machine", "machine_to_controller"], ["never-from-controller", "controller_to_machine"]] as const) {
  for (const [frame = "", when = "", answerText = ""] of table(marker)) {
    neverFrames.add(frame);
    const wanted = answer(answerText);
    if (!wanted || !["any", "before_auth", "after_auth"].includes(when)) { gaps.push(`BAD ${marker} row ${frame}: ${when} / ${answerText}`); continue; }
    const found = cases.some((entry) => entry.frame === frame && entry.direction === direction && entry.refuse?.kind === wanted.kind
      && entry.refuse.code === wanted.code && (when === "any" || entry.context["state"] === when));
    if (!found) gaps.push(`UNCOVERED ${marker} ${frame} (${when}): no case refused ${answerText}`);
  }
}

const causes = table("causes");
const causeKeys = new Set(causes.map(([code = "", message = ""]) => `${code}/${message}`));
for (const [code = "", message = ""] of causes) {
  if (!cases.some((entry) => entry.refuse?.code === code && entry.refuse.message === message)) gaps.push(`UNCOVERED cause ${code} ${message}: no case is refused with it`);
}
for (const entry of cases) {
  if (entry.refuse?.message !== undefined && !causeKeys.has(`${entry.refuse.code}/${entry.refuse.message}`)) gaps.push(`UNDOCUMENTED cause ${entry.refuse.code} ${entry.refuse.message} in case ${entry.name}`);
}

const resetCodes = new Set(table("reset-codes").map(([code = ""]) => code));
for (const code of resetCodes) {
  if (!accepted.some((entry) => entry.frame === "RESET" && entry.parse?.["code"] === code)) gaps.push(`UNCOVERED reset code ${code}: no accepted RESET case carries it`);
}
for (const entry of accepted) {
  if (entry.frame === "RESET" && !resetCodes.has(String(entry.parse?.["code"]))) gaps.push(`UNDOCUMENTED reset code ${String(entry.parse?.["code"])} in case ${entry.name}`);
}

for (const entry of cases) {
  if (!contractFrames.has(entry.frame) && !neverFrames.has(entry.frame)) gaps.push(`BAD case ${entry.name}: frame ${entry.frame} is in no table`);
  else if (contractFrames.has(entry.frame) && contractFrames.get(entry.frame) !== entry.type) gaps.push(`BAD case ${entry.name}: type ${entry.type} for ${entry.frame}`);
}

const recordRows = table("records");
{
  let records: Obj = {};
  try { records = JSON.parse(readFileSync(join(VECTORS, RECORDS_FILE), "utf8")) as Obj; } catch { gaps.push(`MISSING ${RECORDS_FILE} in server/fleet/vectors`); }
  const recordCases = Array.isArray(records["cases"]) ? (records["cases"] as unknown[]).filter(isObj) : [];
  for (const [name = "", stage = "", error = ""] of recordRows) {
    const found = recordCases.find((entry) => entry["name"] === name);
    const refuse = isObj(found?.["expect"]) && isObj(found["expect"]["refuse"]) ? found["expect"]["refuse"] : undefined;
    if (!found) gaps.push(`UNCOVERED record case ${name}: not in ${RECORDS_FILE}`);
    else if (found["stage"] !== stage || refuse?.["error"] !== error) gaps.push(`BAD record case ${name}: ${String(found["stage"])} / ${String(refuse?.["error"])}, the document says ${stage} / ${error}`);
  }
  const transcript = Array.isArray(records["records"]) ? (records["records"] as unknown[]).filter(isObj) : [];
  for (const direction of ["initiator_to_responder", "responder_to_initiator"]) {
    for (const kind of ["binary", "text"]) {
      if (!transcript.some((entry) => entry["direction"] === direction && entry["kind"] === kind)) gaps.push(`UNCOVERED record transcript: no ${kind} record ${direction}`);
    }
  }
}

if (gaps.length) {
  for (const gap of gaps) console.log(gap);
  console.log(`CONTRACT NOT COVERED: ${gaps.length} gap(s)`);
  process.exit(1);
}
console.log(`${frames.length} frames, ${fields.length} fields, ${limits.length} limits, ${causes.length} causes, ${resetCodes.size} reset codes, ${neverFrames.size} refused frame kinds; ${cases.length} cases; ${recordRows.length} record refusals`);
console.log("CONTRACT COVERED");
