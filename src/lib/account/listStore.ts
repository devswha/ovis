/**
 * What this device keeps of its accounts' signed lists (docs/account-list.md, "On a device"), by account: its
 * verified copy of the list, the wraps of the epoch keys it was given, a genesis it signed and has not seen placed,
 * and what its copy and the account service's answers differed in. In an IndexedDB database of its own,
 * `ovis-account-list`: `ovis-account` (store.ts) stays at its one version, which a page of an older build still
 * opens, and a copy can grow to megabytes beside records that are read on every request.
 *
 * Nothing here is a key. The device's two private keys are CryptoKeys that cannot be exported and live in
 * `ovis-account`; an epoch key is never stored, only its wrap, which that device's own key opens again.
 *
 * Every record is read back as `unknown`: whoever owns it reads it strictly and reports what is not in its form.
 */

export const LIST_RECORDS = ["copy", "wraps", "genesis", "shadow"] as const;
export type ListRecord = (typeof LIST_RECORDS)[number];

/** Each call is one transaction. */
export interface ListStore {
  get(record: ListRecord, account: string): Promise<unknown>;
  set(record: ListRecord, account: string, value: unknown): Promise<void>;
  /** Forgets everything kept for the account, in one transaction. */
  drop(account: string): Promise<void>;
}

/** Runs `work` alone among this origin's pages for one account's list (Web Locks), where the browser has them. */
export type ListLock = <T>(account: string, work: () => Promise<T>) => Promise<T>;

export const listLock: ListLock = (account, work) => {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks ? locks.request(`ovis-account-list:${account}`, work) : work();
};

export function memoryListLock(): ListLock {
  const tails = new Map<string, Promise<unknown>>();
  return (account, work) => {
    const run = (tails.get(account) ?? Promise.resolve()).then(work, work);
    tails.set(account, run.catch(() => undefined));
    return run;
  };
}

const nameOf = (record: ListRecord, account: string): string => `${record}:${account}`;

/** What IndexedDB does with a value: a copy that shares nothing with the one handed over. */
export function memoryListStore(): ListStore {
  const records = new Map<string, unknown>();
  return {
    async get(record, account) { return structuredClone(records.get(nameOf(record, account))); },
    async set(record, account, value) {
      if (value === undefined) records.delete(nameOf(record, account));
      else records.set(nameOf(record, account), structuredClone(value));
    },
    async drop(account) { for (const record of LIST_RECORDS) records.delete(nameOf(record, account)); },
  };
}

const DATABASE = "ovis-account-list";
const STORE = "list";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => () => T): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result());
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export const indexedListStore: ListStore = {
  get(record, account) {
    return transact("readonly", (store) => {
      const request = store.get(nameOf(record, account));
      return () => request.result as unknown;
    });
  },
  set(record, account, value) {
    return transact("readwrite", (store) => {
      if (value === undefined) store.delete(nameOf(record, account));
      else store.put(value, nameOf(record, account));
      return () => undefined;
    });
  },
  drop(account) {
    return transact("readwrite", (store) => {
      for (const record of LIST_RECORDS) store.delete(nameOf(record, account));
      return () => undefined;
    });
  },
};
