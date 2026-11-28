import { isIsoTime } from "../../../shared/account-records.ts";
import { ACCOUNT_PROVIDERS, type AccountProvider } from "./store.ts";

/**
 * One way the account signs in; the service keeps no email or login to name it by. `how`: the service added it because
 * it has the account's verified email (`email`), or brought it in with an emptied account of the same email (`fold`);
 * `deniable_until`: until when such a way in can still be taken back with Not me, and is refused what reshapes the account.
 */
export interface AccountIdentity {
  readonly provider: AccountProvider;
  readonly added_at: string;
  readonly how?: "email" | "fold";
  readonly deniable_until?: string;
}

/** `how`: `email` on an add the service made by email, `not_me` on a removal by Not me, `fold` on a merge_in. */
export interface AccountIdentityChange {
  readonly kind: "add" | "remove" | "merge_in";
  readonly provider: AccountProvider;
  readonly at: string;
  readonly device_no: number | null;
  readonly how?: "email" | "not_me" | "fold";
}

const AUTO_METHODS = ["email", "fold"] as const;
const CHANGE_HOWS = ["email", "not_me", "fold"] as const;
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((each) => each === value);

export interface AccountIdentityList {
  readonly identities: AccountIdentity[];
  readonly history: AccountIdentityChange[];
}

export function identityAnswer(body: unknown): AccountIdentityList {
  const answer = typeof body === "object" && body !== null ? body : {};
  const identities: readonly unknown[] = "identities" in answer && Array.isArray(answer.identities) ? answer.identities : [];
  const history: readonly unknown[] = "history" in answer && Array.isArray(answer.history) ? answer.history : [];
  return {
    identities: identities.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || !("provider" in entry) || !("added_at" in entry)) return [];
      const provider = ACCOUNT_PROVIDERS.find((each) => each === entry.provider);
      if (provider === undefined || typeof entry.added_at !== "string") return [];
      const how = "how" in entry ? oneOf(AUTO_METHODS, entry.how) : undefined;
      const until = "deniable_until" in entry && typeof entry.deniable_until === "string" && isIsoTime(entry.deniable_until) ? entry.deniable_until : undefined;
      return [{ provider, added_at: entry.added_at, ...(how === undefined ? {} : { how }), ...(how === undefined || until === undefined ? {} : { deniable_until: until }) }];
    }),
    history: history.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || !("kind" in entry) || !("provider" in entry) || !("at" in entry) || !("device_no" in entry)) return [];
      const { kind, at, device_no } = entry;
      const provider = ACCOUNT_PROVIDERS.find((each) => each === entry.provider);
      if (provider === undefined || (kind !== "add" && kind !== "remove" && kind !== "merge_in")) return [];
      if (typeof at !== "string" || !isIsoTime(at)) return [];
      if (device_no !== null && (typeof device_no !== "number" || !Number.isSafeInteger(device_no) || device_no < 1)) return [];
      const how = "how" in entry ? oneOf(CHANGE_HOWS, entry.how) : undefined;
      return [{ kind, provider, at, device_no, ...(how === undefined ? {} : { how }) }];
    }),
  };
}
