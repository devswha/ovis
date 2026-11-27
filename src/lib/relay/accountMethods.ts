import { nativeSignIn, nativeSignInAvailable } from "../account/native.ts";
import { AccountService, AccountServiceError, SignedOutError } from "../account/service.ts";
import { beginSignIn, redeemSignIn, SignInError, type FinishOptions, type SignInReturn } from "../account/signin.ts";
import type { AccountProvider, PendingSignIn } from "../account/store.ts";

export interface MethodsChange {
  readonly provider: AccountProvider;
  readonly error: string | null;
}

export function accountMethods(account: AccountService, options: Pick<FinishOptions, "store" | "fetch"> & {
  readonly service: string | null;
  readonly open: (url: string) => void;
  readonly changed: () => Promise<void>;
  readonly refresh: () => Promise<void>;
}) {
  let last: MethodsChange | undefined;
  const record = async (provider: AccountProvider, error: string | null): Promise<MethodsChange> => {
    const result = { provider, error };
    last = result;
    await options.changed();
    return result;
  };
  const refused = (provider: AccountProvider, error: Error): Promise<MethodsChange> => {
    if (error instanceof SignInError || error instanceof AccountServiceError || error instanceof SignedOutError) return record(provider, error.code);
    return record(provider, "failed");
  };
  const change = async (provider: AccountProvider, work: () => Promise<void>): Promise<MethodsChange> => {
    try { await work(); } catch (error) {
      if (error instanceof Error) return refused(provider, error);
      throw error;
    }
    return record(provider, null);
  };
  return {
    get last() { return last; },
    methods: () => account.identities(),
    async addMethod(provider: AccountProvider, pc?: string): Promise<void> {
      const { service, store, fetch } = options;
      if (service === null) return;
      if (nativeSignInAvailable()) {
        const result = await change(provider, async () => {
          await account.addMethod(provider, (linkToken, bearer, generation) => nativeSignIn(provider, {
            store, service, ...(fetch === undefined ? {} : { fetch }), link: { linkToken, bearer, generation },
          }));
        });
        if (result.error === null) await options.refresh();
        return;
      }
      try {
        const { linkToken, link, generation, session } = await account.startMethodLink(provider);
        const url = await beginSignIn(provider, {
          store, service: session.service, redirectUri: `${window.location.origin}/`, linkToken, link, generation, ...(pc === undefined ? {} : { pc }),
        });
        await AccountService.checkGeneration(store, generation);
        options.open(url);
      } catch (error) {
        if (error instanceof Error) await refused(provider, error);
        else throw error;
      }
    },
    async removeMethod(provider: AccountProvider): Promise<void> {
      if (options.service === null) return;
      const result = await change(provider, () => account.removeIdentity(provider));
      if (result.error === null) await options.refresh();
    },
    finish(pending: PendingSignIn, returned: SignInReturn): Promise<MethodsChange> {
      const { store, fetch } = options;
      return change(pending.provider, async () => { await redeemSignIn(pending, returned, {
        store, ...(fetch === undefined ? {} : { fetch }), linkService: account,
      }); });
    },
  };
}
