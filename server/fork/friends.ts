import { join } from "node:path";
import type { HerdrPane } from "../../shared/protocol.ts";
import { FRIENDS, friendKey, type Friend, type FriendsResponse } from "../../shared/friends.ts";
import { badRequest, isJsonObject, jsonResponse } from "../http.ts";
import { readStateDocument, writeStateDocument } from "../state-document.ts";

const MAX_KEYS = 2000;
const isFriend = (value: unknown): value is Friend => (FRIENDS as readonly unknown[]).includes(value);
type FriendSource = { id: string; snapshot: { panes: readonly Pick<HerdrPane, "pane_id" | "workspace_id" | "parent_pane_id">[] } | null };
export type FriendLookup = FriendStore["friendOf"];

/** Alert metadata comes from the collector, before the machine manager publishes its roster. */
export function forkAlertFriends(lookup?: FriendLookup) {
  const sources = new Map<string, FriendSource>();
  return {
    seed(panes: readonly HerdrPane[], machineId: string): void {
      sources.set(machineId, { id: machineId, snapshot: { panes } });
    },
    friendOf(machineId: string, paneId: string): Friend | undefined {
      const source = sources.get(machineId);
      return lookup?.(machineId, paneId, source ? [source] : []);
    },
    /** the pane as last seen, for what its alert depends on: whether another agent started it (shared/fork/alerts.ts) */
    pane(machineId: string, paneId: string): Pick<HerdrPane, "parent_pane_id"> | undefined {
      return sources.get(machineId)?.snapshot?.panes.find((pane) => pane.pane_id === paneId);
    },
  };
}

/**
 * Which friend each agent pane wears (shared/friends.ts), kept beside preferences.json so every
 * browser of this server shows the same one. A damaged or unreadable file starts over: the picks
 * are only looks. Project picks live separately so an older server can still rewrite its pane
 * cache without erasing them. Missing snapshot metadata keeps the legacy per-pane behavior.
 */
export class FriendStore {
  private friends: Record<string, Friend> = {};
  private readonly path: string;
  private readonly projectPath: string;
  private projects: Record<string, Friend> = {};
  private projectsWritable = true;

  constructor(stateDir: string, private readonly random = Math.random) {
    this.path = join(stateDir, "friends.json");
    this.projectPath = join(stateDir, "project-friends.json");
    try {
      const projects = readStateDocument(this.projectPath);
      if (projects.kind === "json" && isJsonObject(projects.value) && Object.values(projects.value).every(isFriend)) this.projects = { ...projects.value } as Record<string, Friend>;
      else this.projectsWritable = projects.kind === "missing";
    } catch { this.projectsWritable = false; }
    try {
      const read = readStateDocument(this.path);
      if (read.kind === "json" && isJsonObject(read.value)) {
        for (const [key, friend] of Object.entries(read.value)) if (isFriend(friend)) this.friends[key] = friend;
      }
    } catch { /* starts empty */ }
  }

  /** Frees the gone agent panes of `machines`, gives each new live one a friend, and answers them all. */
  see(live: readonly string[], machines: readonly string[], sources: readonly FriendSource[] = []): FriendsResponse {
    const seen = new Set(live);
    const ownedBy = (key: string) => machines.some((machine) => key.startsWith(`${machine}:`));
    let changed = false;
    for (const key of seen) {
      const source = sources.find((machine) => key.startsWith(`${machine.id}:`));
      const friend = source ? this.projectFriend(source.id, key.slice(source.id.length + 1), sources) : undefined;
      if (friend && this.friends[key] !== friend) { this.friends[key] = friend; changed = true; }
      else if (!this.friends[key]) { this.give(key); changed = true; }
    }
    for (const key of Object.keys(this.friends)) {
      if (!seen.has(key) && ownedBy(key)) { delete this.friends[key]; changed = true; }
    }
    if (changed) this.save();
    return { friends: { ...this.friends } };
  }

  /** The friend a live agent pane wears, given one now if no browser has shown it yet (an alert names it). */
  friendOf(machineId: string, paneId: string, sources: readonly FriendSource[] = []): Friend {
    const key = friendKey(machineId, paneId);
    const project = this.projectFriend(machineId, paneId, sources);
    if (project && this.friends[key] !== project) { this.friends[key] = project; this.save(); }
    const worn = this.friends[key];
    if (worn) return worn;
    const friend = this.give(key);
    this.save();
    return friend;
  }

  private projectFriend(machineId: string, paneId: string, sources: readonly FriendSource[]): Friend | undefined {
    const panes = sources.find((machine) => machine.id === machineId)?.snapshot?.panes;
    let pane = panes?.find((candidate) => candidate.pane_id === paneId);
    if (!pane) return undefined;
    const seen = new Set<string>();
    while (pane.parent_pane_id && !seen.has(pane.pane_id)) {
      seen.add(pane.pane_id);
      const parent = panes?.find((candidate) => candidate.pane_id === pane!.parent_pane_id);
      if (!parent || seen.has(parent.pane_id)) break;
      pane = parent;
    }
    if (!pane.workspace_id) return undefined;
    const key = friendKey(machineId, pane.workspace_id);
    if (!this.projects[key]) {
      this.projects[key] = this.friends[friendKey(machineId, pane.pane_id)] ?? this.friends[friendKey(machineId, paneId)] ?? this.pick(Object.values(this.projects));
      if (this.projectsWritable) {
        try { writeStateDocument(this.projectPath, `${JSON.stringify(this.projects, null, 2)}\n`, false); }
        catch (error) { console.error(`Cannot write ${this.projectPath}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    return this.projects[key];
  }

  // a pane (`machine:workspace:pane`) takes its workspace's friend from an older file, else a new one
  private give(key: string): Friend {
    const workspace = key.slice(0, key.lastIndexOf(":"));
    const kept = workspace.includes(":") ? this.friends[workspace] : undefined;
    if (kept) delete this.friends[workspace];
    return this.friends[key] = kept ?? this.pick();
  }

  // the friends nobody wears, else the ones fewest wear: past nine agents they repeat evenly
  private pick(choices = Object.values(this.friends)): Friend {
    const worn = new Map<Friend, number>(FRIENDS.map((friend) => [friend, 0]));
    for (const friend of choices) worn.set(friend, (worn.get(friend) ?? 0) + 1);
    const least = Math.min(...worn.values());
    const free = FRIENDS.filter((friend) => worn.get(friend) === least);
    return free[Math.floor(this.random() * free.length)] ?? FRIENDS[0];
  }

  private save(): void {
    try { writeStateDocument(this.path, `${JSON.stringify(this.friends, null, 2)}\n`, false); }
    catch (error) { console.error(`Cannot write ${this.path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

/** /api/friends: POST what a browser sees, answered with every agent pane's friend. */
export async function handleFriendsRequest(request: Request, store: FriendStore, sources: () => Promise<readonly FriendSource[]> = async () => []): Promise<Response> {
  if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "Use POST /api/friends" } }, 405);
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("invalid_json", "The body is not JSON"); }
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= MAX_KEYS && value.every((item) => typeof item === "string" && item.length <= 300);
  if (!isJsonObject(body) || !strings(body.live) || !strings(body.machines)) return badRequest("invalid_body", "Send { live: string[], machines: string[] }");
  return jsonResponse(store.see(body.live, body.machines, await sources()), 200, { "cache-control": "no-store" });
}
