import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { decodeOffer } from "../../../shared/relay-offer.ts";
import { closeRelayLink, fetchHealth, requestRelayLink } from "../api.ts";
import { apiFetch } from "../api-request-id.ts";
import { serverIdOfPath } from "../shellMode.ts";
import { pcAccountStatus, within } from "./join.ts";
import { NEW_PC_MS } from "./myPcs.ts";
import type { AccountService } from "./service.ts";

export async function thisPcAccount(): Promise<string | null> {
  return (await pcAccountStatus(apiFetch)).account;
}

export async function thisPcMembership(): Promise<{ readonly account: string | null; readonly enrolling: boolean }> {
  const status = await pcAccountStatus(apiFetch);
  return { account: status.account, enrolling: status.account !== null && status.enrolling === true };
}

export async function thisPcInNoAccount(): Promise<boolean> {
  return await thisPcAccount() === null;
}

export async function reopenAddWindow(): Promise<string | null> {
  const { url } = await openAddWindow();
  try { return decodeOffer(url)?.server_id ?? null; } catch { return null; }
}

export const CLOSE_ANSWER_MS = 60_000;

let closing: Promise<unknown> = Promise.resolve();

export function closeAddWindow(): Promise<{ readonly ok: true }> {
  const sent = closeRelayLink();
  closing = Promise.allSettled([closing, within(CLOSE_ANSWER_MS, sent)]);
  return sent;
}

async function openAddWindow(): Promise<{ url: string }> {
  for (let seen: Promise<unknown> | null = null; seen !== closing;) { seen = closing; await seen; }
  return await requestRelayLink({ localOnly: true });
}

const WAITING_KEY = "ovis-add-pc-waiting";

export interface AddPcWaiting {
  readonly name: string;
  readonly until: number;
  readonly serverId: string;
  readonly account: string;
  readonly listedAt: number;
}

function tabStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage ?? null; } catch { return null; }
}

export function pagePc(): string | null {
  try { return typeof location === "undefined" ? null : serverIdOfPath(location.pathname ?? ""); } catch { return null; }
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;

export async function pcAnswers(serverId: string): Promise<boolean> {
  const told = (await fetchHealth()).web_ui?.server_id;
  const id = text(told) ? told : pagePc();
  if (id === null) throw new Error("This PC did not say which PC it is");
  return id === serverId;
}
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function readAddPcWaiting(): AddPcWaiting | null {
  try {
    const kept = JSON.parse(tabStorage()?.getItem(WAITING_KEY) ?? "null") as Partial<Record<keyof AddPcWaiting, unknown>> | null;
    if (kept === null || typeof kept !== "object") return null;
    const { name, until, serverId, account, listedAt } = kept;
    return typeof name === "string" && time(until) && text(serverId) && text(account) && time(listedAt) ? { name: name.slice(0, 48), until, serverId, account, listedAt } : null;
  } catch { return null; }
}

const watchers = new Set<(waiting: AddPcWaiting | null) => void>();

export function onAddPcWaiting(heard: (waiting: AddPcWaiting | null) => void): () => void {
  watchers.add(heard);
  return () => { watchers.delete(heard); };
}

export function keepAddPcWaiting(waiting: AddPcWaiting | null): void {
  try {
    if (waiting === null) tabStorage()?.removeItem(WAITING_KEY);
    else tabStorage()?.setItem(WAITING_KEY, JSON.stringify(waiting));
  } catch {}
  for (const heard of [...watchers]) heard(waiting);
}

export interface ListedPc { readonly name: string; readonly serverId: string; readonly account: string | null }

export class AddPcWaitOver extends Error {
  constructor(readonly why: "pc" | "sign-in" | "ended") {
    super(`The wait to add this PC is over: ${why}`);
    this.name = "AddPcWaitOver";
  }
}

export interface ListedFor {
  readonly serverId: string;
  readonly account: string;
  readonly running: () => boolean;
}

export interface ListedAs {
  readonly account: string;
  readonly running: () => boolean;
  readonly reached?: (step: "opened" | "writing") => void;
}

export async function listThisPc(service: AccountService, options: { relistMs: number; for?: ListedFor; as?: ListedAs }): Promise<ListedPc> {
  const wait = options.for;
  const as = options.as;
  if (wait !== undefined && !await pcAnswers(wait.serverId)) throw new AddPcWaitOver("pc");
  if (wait !== undefined && !wait.running()) throw new AddPcWaitOver("ended");
  const offer = decodeOffer((await openAddWindow()).url);
  if (offer === null) throw new Error("This PC's pairing link did not parse");
  as?.reached?.("opened");
  if (wait !== undefined && offer.server_id !== wait.serverId) throw new AddPcWaitOver("pc");
  if ((as !== undefined && !as.running()) || (wait !== undefined && !wait.running())) throw new AddPcWaitOver("ended");
  const session = await service.session();
  if (wait !== undefined && session?.account !== wait.account) throw new AddPcWaitOver("sign-in");
  if (as !== undefined && session?.account !== as.account) throw new AddPcWaitOver("sign-in");
  const directory = session === undefined ? service : service.forSignIn(session);
  const runs = (): boolean => (wait === undefined || wait.running()) && (as === undefined || as.running());
  const running = (): void => { if (!runs()) throw new AddPcWaitOver("ended"); as?.reached?.("writing"); };
  const listed = (await directory.listPcs()).find((pc) => pc.server_id === offer.server_id);
  if (listed !== undefined && Date.now() - Date.parse(listed.added_at) >= NEW_PC_MS - options.relistMs) {
    running();
    await directory.deletePc(offer.server_id);
  }
  const name = (offer.name ?? offer.server_id.slice(0, 8)).slice(0, 48);
  const publicKey = Array.from(importPublicKey(offer.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
  running();
  await directory.putPc(offer.server_id, { label: name, public_key: publicKey, relay: offer.relay });
  if (session && runs()) {
    void apiFetch("/api/account/relay-account", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ account: session.account }) }).then(
      (named) => { if (!named.ok && named.status !== 404) console.warn("Ovis: this PC did not take the account for its relay pass", named.status); },
      (error: unknown) => console.warn("Ovis: this PC did not take the account for its relay pass", error instanceof Error ? error.name : error),
    );
  }
  return { name, serverId: offer.server_id, account: session?.account ?? null };
}
