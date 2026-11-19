/**
 * "Not me" on an admission notice (device table T51, T60, T65): this device signs one block of the named
 * key with its own key, and each PC answers for itself. The account's order only says whether to offer it;
 * each PC judges by its own admission order, so a PC is shown done only on its own receipt for a block sent.
 */
import { newRecordId, signSafetyRecord, type BlockRecord } from "../../../shared/account-records.ts";
import { blockOutcome, parseBlockReceipt, type DeviceNotice, type PcBlockOutcome } from "../../../shared/account-devices-api.ts";

export interface OwnKey { readonly public_spki: string; readonly private_key: CryptoKey; readonly no: number }

export async function notMeBlocks(notice: DeviceNotice, own: OwnKey, options: { now?: () => number } = {}): Promise<BlockRecord[]> {
  if (notice.key === null || notice.no === null || notice.account === null || notice.key === own.public_spki || own.no >= notice.no) return [];
  return [await signSafetyRecord({
    v: 1, kind: "block", account: notice.account, target: notice.key, target_no: notice.no, signer: own.public_spki, signer_no: own.no,
    signed_at: new Date((options.now ?? Date.now)()).toISOString(), nonce: newRecordId(),
  }, own.private_key)];
}

export interface FleetBlock {
  readonly ids: readonly string[];
  readonly outcomes: ReadonlyMap<string, PcBlockOutcome>;
}

/** `answer` is what PC `serverId` said over its own channel; anything else, or a receipt for a block not sent, changes nothing. */
export function withBlockReceipt(fleet: FleetBlock, serverId: string, answer: unknown): FleetBlock {
  if (!fleet.outcomes.has(serverId)) return fleet;
  let receipt;
  try { receipt = parseBlockReceipt(answer); } catch { return fleet; }
  if (!fleet.ids.includes(receipt.id)) return fleet;
  return { ...fleet, outcomes: new Map(fleet.outcomes).set(serverId, blockOutcome(serverId, receipt)) };
}

/** One PC's transport for blocks (its notice-answer or POST /api/account/records): the receipts that PC itself sent back. */
export type BlockSend = (records: readonly BlockRecord[]) => Promise<readonly unknown[]>;

/**
 * Sends the blocks to every PC of the account and to the account service at once (device table T60), each PC again
 * with the same records while it cannot be reached (retry by id), and keeps only what each PC answered for itself.
 */
export async function sendBlocks(blocks: readonly BlockRecord[], options: { pcs: ReadonlyMap<string, BlockSend>; service: (blocks: readonly BlockRecord[]) => Promise<void>; tries?: number }): Promise<FleetBlock> {
  const tries = options.tries ?? 3;
  let fleet: FleetBlock = { ids: blocks.map((block) => block.id), outcomes: new Map([...options.pcs.keys()].map((serverId) => [serverId, { server_id: serverId, state: "waiting" as const }])) };
  const toPc = async (serverId: string, send: BlockSend): Promise<void> => {
    for (let attempt = 1; attempt <= tries; attempt++) {
      let receipts: readonly unknown[];
      try { receipts = await send(blocks); } catch {
        if (attempt === tries) fleet = { ...fleet, outcomes: new Map(fleet.outcomes).set(serverId, { server_id: serverId, state: "unreachable" }) };
        continue;
      }
      for (const receipt of receipts) fleet = withBlockReceipt(fleet, serverId, receipt);
      return;
    }
  };
  const service = options.service(blocks).catch((error: unknown) => { console.warn("Ovis: the account service did not take the block", error instanceof Error ? error.name : error); });
  await Promise.all([...[...options.pcs].map(([serverId, send]) => toPc(serverId, send)), service]);
  return fleet;
}
