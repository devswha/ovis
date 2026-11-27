import type { MemberEncryptionKey } from "../../../shared/account-list-seal.ts";
import type { AccountKey, AccountSession, SignInKey } from "./store.ts";

export interface MergeKeys {
  readonly account: string;
  readonly service: string;
  readonly key?: AccountKey;
  readonly encryption?: MemberEncryptionKey;
  readonly signIn?: SignInKey;
  readonly probe?: AccountSession;
  readonly merged?: true;
  readonly into?: string;
  readonly done: readonly string[];
}

export const mergeKeySlot = ({ account, service }: Pick<AccountSession, "account" | "service">): string => JSON.stringify([service, account]);

/** The transaction that ends or replaces a sign-in owns its keys and last token together. */
export function parkMergeKeys(current: {
  readonly key?: AccountKey; readonly enc_key?: MemberEncryptionKey; readonly signin_key?: SignInKey;
  readonly merge_keys?: Readonly<Record<string, MergeKeys>>;
}, from: AccountSession, merged: boolean): Readonly<Record<string, MergeKeys>> | undefined {
  const slot = mergeKeySlot(from);
  const signIn = current.signin_key?.account === from.account ? current.signin_key : undefined;
  const prior = current.merge_keys?.[slot];
  if (current.key === undefined && signIn === undefined && prior === undefined) return current.merge_keys;
  const { probe: _expired, ...rest } = prior ?? { account: from.account, service: from.service, done: [] };
  return { ...current.merge_keys, [slot]: {
    ...rest, ...(current.key === undefined ? {} : { key: current.key }), ...(signIn === undefined ? {} : { signIn }),
    ...(current.enc_key === undefined ? {} : { encryption: current.enc_key }),
    ...(merged ? { merged: true } : { probe: from }),
  } };
}
