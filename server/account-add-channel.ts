/**
 * The adding PC's only use of another PC's recovery socket, reached over SSH for an account add (docs/account.md,
 * "Adding a PC over SSH"). That socket answers every recovery act of its owner (admit, lift, remove, revoke_all...) with
 * no terminal confirm, so nothing else may ever be sent on it: `sendAccountAddAct` is the one function that writes to
 * it and allows exactly two requests, and the channel is closed once take answers, on any error, and after
 * ACCOUNT_ADD_FORWARD_MS at most, stopping a request still waiting. A take that names the account's signed list (`list`,
 * `adder`) may be answered `waiting` with that PC's card: the channel then stays open for the same take again, once the
 * entry that adds it is placed.
 */
import type { SshConnection } from "./ssh.ts";

export type AccountAddRequest =
  | { readonly act: "account_add_inspect" }
  | { readonly act: "account_add_take"; readonly account: string; readonly server_id: string; readonly list?: string; readonly adder?: string };

/** What a take names beside the account, for an account that keeps a signed list: that list, and the key whose entry adds that PC. */
export interface AccountAddNamed { readonly list: string; readonly adder: string }

/** an account service admission lasts ten minutes: a channel kept for an add is closed by then whatever happens */
export const ACCOUNT_ADD_FORWARD_MS = 10 * 60_000;

/** Sends one of the two account-add requests, and nothing else, to the recovery socket at `remoteSocket` on that PC. */
export async function sendAccountAddAct(ssh: SshConnection, remoteSocket: string, request: AccountAddRequest, signal?: AbortSignal): Promise<unknown> {
  const fields = Object.keys(request).sort().join(",");
  const allowed = (request.act === "account_add_inspect" && fields === "act")
    || (request.act === "account_add_take" && (fields === "account,act,server_id" || (fields === "account,act,adder,list,server_id" && typeof request.list === "string" && typeof request.adder === "string"))
      && typeof request.account === "string" && typeof request.server_id === "string");
  if (!allowed) throw new Error("Only an account add's inspect and take go on another PC's recovery socket");
  return JSON.parse(await ssh.askSocket(remoteSocket, JSON.stringify(request), signal)) as unknown;
}

/** A take's answer that the PC waits for the entry that adds it to the account's list. */
const isWaiting = (answer: unknown): boolean => answer !== null && typeof answer === "object" && (answer as { state?: unknown }).state === "waiting";

/** One account add's channel: inspect, then take once; closed after the take, on any error, or when its time is up. */
export class AccountAddChannel {
  #open = true;
  readonly #stop = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  constructor(private readonly ssh: SshConnection, private readonly remoteSocket: string) {
    this.#timer = setTimeout(() => { this.close(); }, ACCOUNT_ADD_FORWARD_MS);
    this.#timer.unref?.();
  }

  get open(): boolean { return this.#open && this.ssh.connected(); }

  async inspect(): Promise<unknown> {
    return await this.#send({ act: "account_add_inspect" }, false);
  }

  /** `named`: the account's list and the adder; an answer `waiting` leaves the channel open for the same take again. */
  async take(account: string, serverId: string, named?: AccountAddNamed): Promise<unknown> {
    return await this.#send(named === undefined ? { act: "account_add_take", account, server_id: serverId } : { act: "account_add_take", account, server_id: serverId, list: named.list, adder: named.adder },
      named === undefined ? true : (answer) => !isWaiting(answer));
  }

  /** Nothing more goes to that PC's socket on this channel, and a request still waiting there is stopped. */
  close(): void {
    if (!this.#open) return;
    this.#open = false;
    clearTimeout(this.#timer);
    this.#stop.abort();
  }

  async #send(request: AccountAddRequest, last: boolean | ((answer: unknown) => boolean)): Promise<unknown> {
    if (!this.#open) throw new Error("This account add's connection to that PC is closed");
    try {
      const answer = await sendAccountAddAct(this.ssh, this.remoteSocket, request, this.#stop.signal);
      if ((typeof last === "function" ? last(answer) : last) || (answer !== null && typeof answer === "object" && "error" in answer)) this.close();
      return answer;
    } catch (error) {
      this.close();
      throw error;
    }
  }
}
