/**
 * The hosts an ssh config names, for the SSH tab's list (server/ssh-candidates.ts), with what ssh would use for each,
 * read offline: nothing the config names is run, and a condition only running something could settle is left unknown.
 */
import { userInfo } from "node:os";

/** Include may nest; ssh itself stops at 16 */
const MAX_INCLUDE_DEPTH = 4;
/** hosts listed at most, so a generated config costs a bounded list */
export const MAX_HOSTS = 200;
/** aliases weighed against the config at most, listed or not, so aliases no block applies to cost a bounded list too */
const MAX_WEIGHED = 2 * MAX_HOSTS;
/** the options ssh takes from the first block that applies to a host, whichever block sets them */
const EFFECTIVE_KEYS = new Set(["hostname", "addressfamily", "proxycommand", "proxyjump", "user"]);
/** the Match conditions weighed here; any other (`exec`, `canonical`, `final`, `localnetwork`...) is unknown offline */
const WEIGHED = ["host", "originalhost", "user", "localuser"] as const;

/** a host an ssh config names, with what ssh would use for it */
export interface ConfigHost {
  alias: string;
  hostname: string | null;
  user: string | null;
  /** the AddressFamily ssh connects over, when it is not `any` */
  addressFamily?: "inet" | "inet6";
  /** set when ssh goes through a ProxyCommand or ProxyJump, so the name is resolved at the far end, not here */
  proxied?: true;
  /** set when a Match condition that cannot be weighed offline may change where or how ssh connects to it */
  undetermined?: true;
}

/** whether `part` (`?` standing for any one character) matches `text` at `at` */
const fitsAt = (part: string, text: string, at: number): boolean => {
  for (let index = 0; index < part.length; index++) if (part[index] !== "?" && part[index] !== text[at + index]) return false;
  return true;
};

/** where `part` first matches `text` from `from` on, ending by `end`, or -1; one pass (Knuth-Morris-Pratt) unless it holds a `?` */
function findPart(part: string, text: string, from: number, end: number): number {
  if (part.includes("?")) {
    for (let at = from; at + part.length <= end; at++) if (fitsAt(part, text, at)) return at;
    return -1;
  }
  if (part === "") return from;
  const fallback = new Int32Array(part.length);
  for (let index = 1, length = 0; index < part.length; index++) {
    while (length > 0 && part[index] !== part[length]) length = fallback[length - 1]!;
    if (part[index] === part[length]) length++;
    fallback[index] = length;
  }
  for (let at = from, length = 0; at < end; at++) {
    while (length > 0 && text[at] !== part[length]) length = fallback[length - 1]!;
    if (text[at] === part[length]) length++;
    if (length === part.length) return at - length + 1;
  }
  return -1;
}

/**
 * Whether `text` matches an ssh pattern (`*` any run, `?` one character), compared as given: callers lowercase what ssh
 * compares in lowercase. The ends are checked in place and each part between stars is taken at its first place, which
 * is never worse, so `*aaa…ab` against a long alias costs one pass instead of one per start.
 */
export function globMatch(glob: string, text: string): boolean {
  const parts = glob.split("*");
  if (parts.length === 1) return glob.length === text.length && fitsAt(glob, text, 0);
  const [first, last] = [parts[0]!, parts.at(-1)!];
  const end = text.length - last.length;
  if (first.length > end || !fitsAt(first, text, 0) || !fitsAt(last, text, end)) return false;
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = findPart(part, text, at, end);
    if (found < 0) return false;
    at = found + part.length;
  }
  return true;
}

/** ssh's pattern list (`a,b,!c`): a negated pattern that matches says no, else one other pattern matching says yes */
const listMatches = (list: string, text: string): boolean => {
  const patterns = list.split(",");
  return !patterns.some((pattern) => pattern.startsWith("!") && globMatch(pattern.slice(1), text)) &&
    patterns.some((pattern) => !pattern.startsWith("!") && globMatch(pattern, text));
};

/** a Host pattern that names one host, not a set of them */
const plainAlias = (pattern: string): boolean => pattern !== "" && !/[*?!]/.test(pattern);

/**
 * `Key value`, `Key=value` and `Key "quoted value"`, as ssh reads a line, up to a word that starts a comment
 * (`Host lab # work` names `lab` alone); null for a blank line or a comment
 */
function keyword(line: string): { key: string; values: string[] } | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(trimmed);
  if (match === null) return null;
  const values: string[] = [];
  for (const part of match[2]!.matchAll(/"([^"]*)"|(\S+)/g)) {
    if (part[2]?.startsWith("#")) break;
    values.push(part[1] ?? part[2]!);
  }
  return { key: match[1]!.toLowerCase(), values };
}

type Criterion = { negate: boolean } & ({ on: "all" | "unknown" } | { on: (typeof WEIGHED)[number]; patterns: string });
/** a Host or Match block, in lowercase; `within` is the block an Include sat in when this one came from the included file */
type Block =
  | { kind: "host"; patterns: string[]; aliases: string[]; user?: string; within?: Block }
  | { kind: "match"; criteria: Criterion[]; within?: Block };
type HostBlock = Extract<Block, { kind: "host" }>;
/** in file order: an option line, or a Match line, weighed where it stands since it reads the options set before it */
type Entry = { block: Block; key: string; value: string } | { block: Block };

const isWeighed = (on: string): on is (typeof WEIGHED)[number] => (WEIGHED as readonly string[]).includes(on);

/** a Match line's conditions, as ssh reads them: `all`, `canonical` and `final` alone, any other with its argument */
function matchCriteria(values: string[]): Criterion[] {
  const criteria: Criterion[] = [];
  for (let index = 0; index < values.length; index++) {
    const negate = values[index]!.startsWith("!");
    const word = values[index]!.slice(negate ? 1 : 0);
    const equals = word.indexOf("=");
    const on = (equals < 0 ? word : word.slice(0, equals)).toLowerCase();
    if (on === "all" || on === "canonical" || on === "final") { criteria.push({ negate, on: on === "all" ? "all" : "unknown" }); continue; }
    const patterns = equals < 0 ? values[++index] ?? "" : word.slice(equals + 1);
    criteria.push(isWeighed(on) ? { negate, on, patterns: on === "host" || on === "originalhost" ? patterns.toLowerCase() : patterns } : { negate, on: "unknown" });
  }
  return criteria;
}

/** what ssh would use for one alias so far: each option's value (null: unknown offline), and whether each block applies */
interface Weighing { alias: string; localUser: string | null; effective: Map<string, string | null>; applies: Map<Block, boolean | null> }

const expandHost = (hostname: string, alias: string): string => hostname.replace(/%([%h])/g, (_, token: string) => token === "h" ? alias : "%");
const allOf = (verdicts: (boolean | null)[]): boolean | null => verdicts.includes(false) ? false : verdicts.includes(null) ? null : true;

/** whether a Match condition holds for the alias given the options set so far, as ssh weighs it; null when unknown offline */
function holds({ alias, localUser, effective }: Weighing, criterion: Criterion): boolean | null {
  const user = effective.get("user") === undefined ? localUser : effective.get("user")!;
  const hostname = effective.get("hostname");
  let verdict: boolean | null;
  switch (criterion.on) {
    case "all": verdict = true; break;
    case "unknown": verdict = null; break;
    case "originalhost": verdict = listMatches(criterion.patterns, alias); break;
    case "host": verdict = hostname === null ? null : listMatches(criterion.patterns, hostname === undefined ? alias : expandHost(hostname, alias).toLowerCase()); break;
    case "user": verdict = user === null ? null : listMatches(criterion.patterns, user); break;
    case "localuser": verdict = localUser === null ? null : listMatches(criterion.patterns, localUser); break;
    default: { const unreachable: never = criterion; throw new Error(`unknown Match criterion ${JSON.stringify(unreachable)}`); }
  }
  return verdict === null || !criterion.negate ? verdict : !verdict;
}

/**
 * Whether a block applies to the alias: a Host line when one of its patterns matches and none of its negated ones does,
 * a Match line when all its conditions hold; and the block of the Include that brought it in applies too, as ssh reads
 * an included file only for the hosts that block applies to
 */
function applies(weighing: Weighing, block: Block): boolean | null {
  const known = weighing.applies.get(block);
  if (known !== undefined) return known;
  const outer = block.within === undefined ? true : applies(weighing, block.within);
  const own = outer === false ? false : block.kind === "match" ? allOf(block.criteria.map((criterion) => holds(weighing, criterion))) :
    block.patterns.some((pattern) => !pattern.startsWith("!") && globMatch(pattern, weighing.alias)) &&
    !block.patterns.some((pattern) => pattern.startsWith("!") && globMatch(pattern.slice(1), weighing.alias));
  const verdict = allOf([outer, own]);
  weighing.applies.set(block, verdict);
  return verdict;
}

/** the options ssh would take for `alias` (in lowercase), line by line: the first block that applies sets each one */
function weigh(entries: Entry[], alias: string, localUser: string | null): Weighing {
  const weighing: Weighing = { alias, localUser, effective: new Map(), applies: new Map() };
  for (const entry of entries) {
    if (!("key" in entry)) { applies(weighing, entry.block); continue; }
    if (weighing.effective.has(entry.key)) continue;
    const verdict = applies(weighing, entry.block);
    // a block that may apply makes the option unknown: whichever way it goes, no later block sets it
    if (verdict !== false) weighing.effective.set(entry.key, verdict === true ? entry.value : null);
  }
  return weighing;
}

const currentUser = (): string | null => { try { return userInfo().username; } catch { return null; } };

/**
 * The hosts an ssh config names, in its order, with what ssh would use for each: the HostName, AddressFamily and
 * proxy the first block that applies to it sets (a later `Host *` or Match included, `%h` standing for the alias), and
 * the first User its own block sets. A Match block is weighed for `all`, `host`, `originalhost`, `user` and `localuser`
 * (`localUser` being this account); any other condition leaves what its block sets unknown, and the host undetermined.
 * Hosts named only by a pattern (`*`, `?`, `!`), or in an included file whose Include's block does not apply to them,
 * are left out; a later block repeating an alias adds nothing. `include(pattern)` reads the files an Include names, as
 * text, in their order.
 */
export async function sshConfigHosts(text: string, include: (pattern: string) => Promise<string[]> = async () => [], localUser = currentUser()): Promise<ConfigHost[]> {
  const blocks: HostBlock[] = [];
  const entries: Entry[] = [];
  // lines before the first Host apply to every host, as in ssh
  let current: Block = { kind: "host", patterns: ["*"], aliases: [] };
  const walk = async (text: string, depth: number, within?: Block): Promise<void> => {
    for (const line of text.split(/\r?\n/)) {
      const parsed = keyword(line);
      if (parsed === null) continue;
      if (parsed.key === "host") {
        // `Host valid server-*` still names `valid`; a negated pattern on the line leaves out each alias it matches
        // (`Host web01 !web*` names nothing), as ssh never applies the block to that host
        const patterns = parsed.values.map((value) => value.toLowerCase());
        const negated = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
        const block: HostBlock = { kind: "host", patterns, aliases: parsed.values.filter((value) => plainAlias(value) && !negated.some((pattern) => globMatch(pattern, value.toLowerCase()))), within };
        blocks.push(block);
        current = block;
      } else if (parsed.key === "match") {
        current = { kind: "match", criteria: matchCriteria(parsed.values), within };
        entries.push({ block: current });
      } else if (parsed.key === "include" && depth < MAX_INCLUDE_DEPTH) {
        // as ssh reads it: an included file goes on in the block the Include sits in (its options before a Host line
        // of its own are that block's), and the including file's block goes on after it. Each file starts in the
        // Include's own block: a Host line in one file does not carry into the next
        const outer: Block = current;
        for (const pattern of parsed.values) {
          for (const included of await include(pattern)) {
            current = outer;
            await walk(included, depth + 1, outer);
          }
        }
        current = outer;
      } else {
        if (EFFECTIVE_KEYS.has(parsed.key) && parsed.values[0] !== undefined) entries.push({ block: current, key: parsed.key, value: parsed.values[0] });
        if (parsed.key === "user" && current.kind === "host" && current.user === undefined) current.user = parsed.values[0];
      }
    }
  };
  await walk(text, 0);
  const seen = new Set<string>();
  const hosts: ConfigHost[] = [];
  let weighed = 0;
  for (const block of blocks) {
    for (const alias of block.aliases) {
      // the list stops at its limits, so a huge config costs its option lines once per weighed alias at most
      if (hosts.length >= MAX_HOSTS || weighed >= MAX_WEIGHED) return hosts;
      if (seen.has(alias)) continue;
      weighed += 1;
      const weighing = weigh(entries, alias.toLowerCase(), localUser);
      if (applies(weighing, block) !== true) continue;
      seen.add(alias);
      const { effective } = weighing;
      const hostname = effective.get("hostname");
      const family = effective.get("addressfamily")?.toLowerCase();
      const proxied = ["proxycommand", "proxyjump"].some((key) => (effective.get(key) ?? "none").toLowerCase() !== "none");
      const undetermined = ["hostname", "addressfamily", "proxycommand", "proxyjump"].some((key) => effective.get(key) === null);
      hosts.push({
        alias, hostname: hostname == null ? null : expandHost(hostname, alias), user: block.user ?? null,
        ...(family === "inet" || family === "inet6" ? { addressFamily: family } : {}), ...(proxied ? { proxied: true as const } : {}),
        ...(undetermined ? { undetermined: true as const } : {}),
      });
    }
  }
  return hosts;
}
