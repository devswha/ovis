/**
 * An account that was in use moving onto its signed list, for a PC under test (docs/account-list.md, "An account that
 * was in use"): devices that are signed in with a sign-in key and hold an account key, and the list the first of them
 * makes in one request. The account service fake of this build takes no `carried` yet, so the birth is placed as its
 * entry 0 and the rest is served after it (tamperList `inject`), as the service would serve a whole birth.
 */
import { epochKeyCommitment, generateStoredEncryptionKey, newEpochKey, nextEpoch, readStoredEncryptionKey, sealFields, type EpochKey } from "../../shared/account-list-seal.ts";
import { cardBinding, namesFields, signCard, signListEntry, type ListKind, type ListSigner, type ListState } from "../../shared/account-list.ts";
import type { ListPlace } from "../../shared/account-list-signers.ts";
import { signMigration, signNaming, signRotation, signVouch, type MigratingDevice, type MigrationPlan, type MigrationSeals, type SignedNaming, type SignedVouch } from "../../shared/account-list-migrate.ts";
import { accountDeviceId, exportAccountKey } from "../../shared/account-records.ts";
import type { FakeAccountService } from "../../shared/account-service-fake.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";

const SERVICE = "https://account.test";
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** A device of the account: its sign-in key, which the PCs let in today, and its account key, which the list goes on with. */
export interface MigratingPhone extends MigratingDevice {
  readonly label: string;
  readonly signInPair: CryptoKeyPair;
  readonly memberPair: CryptoKeyPair;
}

export async function migratingDevice(label: string): Promise<MigratingPhone> {
  const signInPair = await crypto.subtle.generateKey(P256, false, ["sign", "verify"]);
  const memberPair = await crypto.subtle.generateKey(P256, false, ["sign", "verify"]);
  const enc = (await readStoredEncryptionKey((await generateStoredEncryptionKey()).secret)).key;
  return {
    label, signInPair, memberPair, enc, names: { label, os: "ios" },
    signIn: { key: await exportAccountKey(signInPair.publicKey), privateKey: signInPair.privateKey },
    member: { key: await exportAccountKey(memberPair.publicKey), privateKey: memberPair.privateKey },
  };
}

/** The same device after it signed in again: a new sign-in key, the same account key. */
export async function signedInAgain(device: MigratingPhone): Promise<MigratingPhone> {
  const signInPair = await crypto.subtle.generateKey(P256, false, ["sign", "verify"]);
  return { ...device, signInPair, signIn: { key: await exportAccountKey(signInPair.publicKey), privateKey: signInPair.privateKey } };
}

/** What a relay sign-in with one of a device's keys needs: the pair, and the account id the PC knows that key by. */
export function asSignIn(serverId: string, device: MigratingPhone, which: "signIn" | "member" = "signIn") {
  const pair = which === "signIn" ? device.signInPair : device.memberPair;
  const key = which === "signIn" ? device.signIn.key : device.member.key;
  return { keys: pair, publicKey: key, id: accountDeviceId(serverId, key) };
}

/** The first device's side of sealing, with real epoch keys. */
function sealer(): MigrationSeals {
  const keys = new Map<number, EpochKey>();
  const current = (epoch: number): EpochKey => {
    const key = keys.get(epoch);
    if (key === undefined) throw new Error(`no key of epoch ${epoch}`);
    return key;
  };
  return {
    async genesis(given) {
      const epoch = newEpochKey(0);
      keys.set(0, epoch);
      const opens = epochKeyCommitment({ list: "", epoch });
      return { opens, sealed: given === null ? null : { epoch: 0, bytes: await sealFields({ place: { list: "", seq: 0 }, epoch, commitment: opens, fields: namesFields(given) }) } };
    },
    async names(place, epoch, given) {
      return { epoch: epoch.epoch, bytes: await sealFields({ place, epoch: current(epoch.epoch), commitment: epoch.opens, fields: namesFields(given) }) };
    },
    async next(list, epoch, members) {
      const made = await nextEpoch({ list, current: current(epoch), members });
      keys.set(made.epoch.epoch, made.epoch);
      return { opens: made.commitment, link: made.link };
    },
  };
}

/** The plan of a birth: these devices' sign-in keys carried in, devices first, then these PCs as endpoints with no key. */
export function birthPlan(devices: readonly MigratingPhone[], pcs: readonly string[] = []): Pick<MigrationPlan, "devices" | "pcs"> {
  return { devices: devices.map((one) => ({ key: one.signIn.key, names: one.names })), pcs: pcs.map((endpoint) => ({ endpoint, names: null })) };
}

/** A list born by migration, as the account service shows it: every entry a member signed, and what a member holds after the last. */
export class MigratedList {
  private constructor(private readonly service: FakeAccountService, readonly account: string, readonly id: string, readonly texts: string[], private held: ListState, private readonly clock: () => number) {}

  /** The first device's one request: entry 0 placed at the account service, the rest of the birth served after it. */
  static async born(service: FakeAccountService, account: string, first: MigratingPhone, plan: Pick<MigrationPlan, "devices" | "pcs">, clock: () => number): Promise<MigratedList> {
    const made = await signMigration(account, plan, first, clock(), sealer());
    const texts = made.entries.map((entry) => entry.text);
    const answer = await service.fetch(new Request(`${SERVICE}/v2/lists`, { method: "POST", headers: { authorization: `Bearer ${service.issueToken(account, { twoStep: true })}` }, body: JSON.stringify({ entry: texts[0] }) }));
    if (answer.status !== 201) throw new Error(`The birth was not taken: ${answer.status} ${await answer.text()}`);
    const list = new MigratedList(service, account, made.list, texts, made.state, clock);
    list.serve();
    return list;
  }

  get state(): ListState { return this.held; }
  get head(): ListPlace { return { seq: this.held.footing.seq, hash: this.held.footing.hash }; }

  /** An entry of `kind` signed by `signer` after the last one: served at once, unless `serve` is false (a member hands it over itself). */
  async append(kind: ListKind, signer: ListSigner, serve = true): Promise<string> {
    const written = await signListEntry(this.held, kind, signer, this.clock());
    this.texts.push(written.text);
    this.held = written.state;
    if (serve) this.serve();
    return written.text;
  }

  /** A carried device hands its place to its account key, as it does once it follows the list. */
  async handOver(device: MigratingPhone, serve = true): Promise<string> {
    const written = await signRotation(this.held, device, this.clock(), null);
    this.texts.push(written.text);
    this.held = written.state;
    if (serve) this.serve();
    return written.text;
  }

  /** A member adds the PC at `endpoint` from the keys that PC posted (the second lock), with its card as posted. */
  async addPostedPc(endpoint: string, by: ListSigner, serve = true): Promise<string> {
    const answer = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/posts`, { headers: { authorization: `Bearer ${this.service.issueToken(this.account, { twoStep: true })}` } }));
    const post = (await answer.json() as { posts: { endpoint: string; key: string; enc: string; card: string }[] }).posts.find((one) => one.endpoint === endpoint);
    if (!post) throw new Error("The PC posted no keys");
    return await this.append({ kind: "pc", key: post.key, endpoint, enc: post.enc, card: post.card, sealed: null }, by, serve);
  }

  /** A member puts a key out. */
  remove(key: string, by: ListSigner, serve = true): Promise<string> { return this.append({ kind: "remove", ends: key }, by, serve); }

  /** A device names this list to the PC at `endpoint`, in a session signed in with `session`, by the key the list holds it by. */
  async naming(device: MigratingPhone, session: string, endpoint: string, which: "signIn" | "member" = "member"): Promise<SignedNaming> {
    const signed = await signNaming(this.held, { member: which === "member" ? device.member : device.signIn, session, endpoint });
    if (signed === null) throw new Error("That device names nothing");
    return signed;
  }

  /** The link of a device's present sign-in key to its account key, as it hands it to a PC. */
  async vouch(device: MigratingPhone): Promise<SignedVouch> {
    const signed = await signVouch(this.held, device);
    if (signed === null) throw new Error("That device vouches for nothing");
    return signed;
  }

  /** A card some other key signs for this PC's relay key: what a member that did nothing for that PC must not sign into a `pc` entry. */
  card(given: { key: string; enc: string; endpoint: string }, privateKey: CryptoKey): Promise<string> {
    return signCard({ ...given, list: this.id, endpoint: given.endpoint, invite: null }, privateKey);
  }

  /**
   * The adder's side of the number it compares with a PC that posted its keys (B7; the account service only carries
   * it): `commit` opens the attempt, `reveal` takes the PC's nonce and answers the six digits the adder's screen shows,
   * null while the PC has not answered.
   */
  async compare(endpoint: string, adder: ListSigner): Promise<{ readonly commit: () => Promise<void>; readonly reveal: () => Promise<string | null> }> {
    const token = this.service.issueToken(this.account, { twoStep: true });
    const answer = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/posts`, { headers: { authorization: `Bearer ${token}` } }));
    const post = (await answer.json() as { posts: { endpoint: string; key: string; enc: string }[] }).posts.find((candidate) => candidate.endpoint === endpoint);
    if (!post) throw new Error("The PC posted no keys");
    const binding = cardBinding({ key: post.key, enc: post.enc, list: this.id, endpoint, invite: null });
    const nonce = randomPairNonce();
    const commitment = toBase64Url(pairCommitment(binding, adder.key, nonce));
    const send = async (reveal?: string): Promise<{ nonce: string | null } | null> => {
      const sent = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/posts/${endpoint}/attempt`, { method: "POST", headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ key: post.key, adder: adder.key, commitment, ...(reveal === undefined ? {} : { reveal }) }) }));
      if (sent.status === 409) return null;
      if (!sent.ok) throw new Error(`The attempt was not taken: ${sent.status} ${await sent.text()}`);
      return (await sent.json() as { attempt: { nonce: string | null } }).attempt;
    };
    return {
      commit: async () => { if (await send() === null) throw new Error("The attempt was not opened"); },
      reveal: async () => {
        const open = await send(toBase64Url(nonce));
        return open === null || open.nonce === null ? null : pairDigits(binding, adder.key, nonce, fromBase64Url(open.nonce));
      },
    };
  }

  /** The account service shows every entry: entry 0 is placed, the rest is served after it. */
  serve(): void {
    this.service.untamperList(this.id);
    if (this.texts.length > 1) this.service.tamperList(this.id, { inject: this.texts.slice(1) });
  }
}
