import { Monitor } from "lucide-react";
import { useEffect, useState } from "react";
import { ACCOUNT_PCS_CHANGED_EVENT, myPcs, newPcs, type MyPc } from "../lib/account/myPcs.ts";
import { ACCOUNT_SIGN_OUT_EVENT, indexedAccountService, SignedOutError, type AccountService } from "../lib/account/service.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { indexedDeviceStore, type RelayDevice } from "../lib/relay/device.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { usePcRemoval } from "./usePcRemoval.tsx";

import "./DevicePairedNotice.css";
import "./UpdateControls.css";

type Asking = { readonly session: AccountSession; readonly pcs: readonly MyPc[] };

/**
 * A PC that asks to join the account, as the PC's own Add this PC to my account leaves it when its one press is refused
 * ("On another device of your account, choose Add on {name}"): listed by an own sign-in, never in yet (it has not pulled
 * the account's mailbox), its request under ten minutes old, with a key its id is derived from (myPcs `join`, newPcs),
 * and no pairing of this device with it. A launch that goes straight into another PC never shows its join card, so this
 * device says so here: Allow opens that PC's own page, whose join takes the number the PC's screen shows and the PC's
 * approval (the guards of every join, AddPcSheet). Decline denies the request: it removes the listing with this sign-in
 * (DELETE /v1/pcs/:id), so no device shows it and the PC is not added; the waiting PC ends its wait (AccountSection
 * deniedElsewhere) and asks again only by a new press. Only an app's own sign-in is offered either.
 */
const pairedHere = (): Promise<readonly RelayDevice[]> => indexedDeviceStore.list();
const openPcPage = (serverId: string): void => window.location.assign(serverScopePath(serverId));

export function AccountJoinRequests({ service = indexedAccountService, devices = pairedHere, now = Date.now, open = openPcPage }: {
  readonly service?: AccountService;
  readonly devices?: () => Promise<readonly RelayDevice[]>;
  readonly now?: () => number;
  readonly open?: (serverId: string) => void;
}) {
  const t = useT();
  const [asking, setAsking] = useState<Asking | null>(null);
  const [denied, setDenied] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // a Decline is a removal (PCR-1): one the service wants a fresh own sign-in for says so, with Sign in again, in its card
  const removal = usePcRemoval(service, (serverId) => {
    setDenied((prior) => new Set([...prior, serverId]));
    window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
  });
  useEffect(() => {
    let version = 0;
    const read = async (): Promise<void> => {
      const mine = ++version;
      try {
        const session = await service.session();
        if (mine !== version) return;
        if (session === undefined) { setAsking(null); return; }
        const directory = service.forSignIn(session);
        const [own, listed, here] = await Promise.all([directory.ownSignIn(), directory.listPcs(), devices()]);
        if (mine !== version) return;
        // a device code's sign-in is no one's to let a PC in or turn it away with
        setAsking(own ? { session, pcs: newPcs(myPcs(listed, here, { now: now() }), now()) } : null);
      } catch (error) {
        if (mine !== version) return;
        if (error instanceof SignedOutError) setAsking(null);
        else if (error instanceof Error) console.warn("Ovis: the PCs asking to join could not be read", error.name);
        else throw error;
      }
    };
    const visibleRead = (): void => { if (document.visibilityState === "visible") void read(); };
    void read();
    document.addEventListener("visibilitychange", visibleRead);
    window.addEventListener("focus", visibleRead);
    window.addEventListener(ACCOUNT_SIGN_OUT_EVENT, visibleRead);
    window.addEventListener(ACCOUNT_PCS_CHANGED_EVENT, visibleRead);
    return () => {
      version++;
      document.removeEventListener("visibilitychange", visibleRead);
      window.removeEventListener("focus", visibleRead);
      window.removeEventListener(ACCOUNT_SIGN_OUT_EVENT, visibleRead);
      window.removeEventListener(ACCOUNT_PCS_CHANGED_EVENT, visibleRead);
    };
  }, [service, devices, now]);

  if (asking === null) return null;
  const deny = async (pc: MyPc): Promise<void> => {
    if (busy !== null) return;
    setBusy(pc.server_id);
    setFailed(null);
    try {
      await removal.remove(asking.session, pc.server_id);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setFailed(pc.server_id);
    } finally { setBusy(null); }
  };
  return asking.pcs.filter((pc) => !denied.has(pc.server_id)).map((pc) => (
    <div key={pc.server_id} className="update-notice is-paired device-notice" role="status" data-join-request={pc.server_id}>
      <Monitor aria-hidden="true" />
      <span className="device-notice-text">
        <span>{t("\"{name}\" asks to join your account", { name: pc.name })}</span>
        {failed === pc.server_id && <span className="account-error" role="alert">{t("The request could not be declined. Try again.")}</span>}
        {removal.promptFor === pc.server_id && removal.prompt}
      </span>
      <div className="device-paired-actions">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => open(pc.server_id)}>{t("Allow")}</button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void deny(pc)}>{t("Decline")}</button>
      </div>
    </div>
  ));
}
