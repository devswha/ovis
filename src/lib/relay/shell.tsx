// allow: SIZE_OK - One state-machine closure shares attempt ownership across connection, cancellation and admission handlers.
import { createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { encodeOffer, type RelayOffer } from "../../../shared/relay-offer.ts";
import { GLOBAL_RELAY } from "../../../shared/relay-regions.ts";
import { RelayShell } from "../../components/RelayShell.tsx";
import type { MyPc } from "../account/myPcs.ts";
import { sameSignIn } from "../account/service.ts";
import type { AccountSession } from "../account/store.ts";
import { signInReturn } from "../account/signin.ts";
import { deviceLabel } from "../phone.ts";
import { registerPendingPush } from "../push.ts";
import { alertPrefs, loadSettings, SettingsProvider } from "../settings.ts";
import { readAlertFilters, withAlertFilters } from "../alertFilters.ts";
import { onLazyChunkFailure } from "../lazyChunk.ts";
import { setTransport } from "../transport.ts";
import { takeEntryUrl } from "./boot.ts";
import { nativeDirectSocket, nativeDirectTailnet } from "./directSocket.ts";
import { enrollmentOf, indexedDeviceStore, indexedPendingPush, ServerIdentityChangedError } from "./device.ts";
import { failureOf, forgedOffer, forgetsDevice, iosBrowserTab, keyMismatch, offerOf, pairsAgainWithoutKey, shellEntry, sheetContext, keepSheetContext, typedJoin, keepTypedJoin, dashboardHash, keepConfirmedPc, takeConfirmedPc, keepDeviceOnlyPc, deviceOnlyPc, keepConfirmedSignIn, confirmedSignIn } from "./shellState.ts";
import type { Attempt, RelayShellMount, RelayShellState, SheetJoin } from "./shellState.ts";
import { openRelayTransport, type RelayTransport } from "./transport.ts";
import { offerFromCode, TypedCodeError } from "./pairCode.ts";
import { ConsentChangedError, createAccountController } from "./accountController.ts";
import { createPcSweep } from "./pcSweep.ts";
import { createUpdateFlow, loadObservedVersions, observedVersions, reloadPage, freshShellNext, forgetSavedPc } from "./updateFlow.ts";
export type { RelayShellMount } from "./shellState.ts";
export { forgetSavedPc } from "./updateFlow.ts";
declare const __APP_VERSION__: string;
const INTRODUCED_GRACE_MS = 15 * 60_000;
export const ACCOUNT_READ_WAIT_MS = 8_000;
export const ACCOUNT_STEPS_WAIT_MS = 15_000;


export async function mountRelayShell(mount: RelayShellMount): Promise<void> {
  const store = mount.store ?? indexedDeviceStore;
  await loadObservedVersions(store);
  const open = mount.open ?? openRelayTransport;
  const navigate = mount.navigate ?? ((path: string) => window.location.assign(path));
  const label = mount.label ?? deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  let entry = shellEntry(mount.entryUrl);
  const scoped = entry.serverId !== null;
  const iosTab = iosBrowserTab({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, standalone: "standalone" in navigator && navigator.standalone === true });
  let shell: Root | null = null, app: Root | null = null, transport: RelayTransport | null = null;
  let last: Attempt | null = null, opening: AbortController | null = null;
  let shown: RelayShellState | null = null, sheetJoin: SheetJoin | null = null, codeOffer: RelayOffer | null = null;
  let comparison: { name: string | null; digits: string; matched: () => void; typed: boolean } | null = null;
  let challenge = 0, checked = false;
  const enrolling = new Set<RelayTransport>();
  const directSocket = nativeDirectSocket();
  const directTailnet = directSocket ? nativeDirectTailnet() : undefined;
  const findByCode = mount.findByCode ?? offerFromCode;
  const pendingPush = mount.pendingPush ?? indexedPendingPush;
  const registerPending = (serverId: string): void => {
    registerPendingPush(serverId, pendingPush, withAlertFilters(alertPrefs(loadSettings()), readAlertFilters())).catch((error: unknown) => {
      console.warn("Ovis: the PC did not take this device's new push subscription", error);
    });
  };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
      if (transport === null || last === null || (event.data as { type?: unknown } | null)?.type !== "push-subscription-change") return;
      registerPending(last.offer.server_id);
    });
  }

  onLazyChunkFailure(() => { if (entry.serverId !== null) void freshShellNext(entry.serverId); });
  const frontUp = (): boolean => app === null && (sheetJoin !== null || shown === null || shown.kind === "list" || shown.kind === "empty");
  let accountRead = false;
  let confirming = false;
  let pressed: "unlisted" | "listed" | "own" | undefined;
  let press = 0;
  let unanswered = false;
  let readWait: ReturnType<typeof setTimeout> | undefined;
  const drawnFor = new WeakMap<RelayShellState, AccountSession>();
  const accountChanged = async (): Promise<void> => {
    const read = account.state?.kind !== "signing-in";
    if (read) accountRead = true;
    if (read && (account.state?.kind !== "signed-in" || account.state.pcs !== null)) unanswered = false;
    if (app === null && shown?.kind === "confirm") show(confirmOf(shown.offer));
    else if (frontUp()) { if (sheetJoin && shown) show(shown); else await showFront(); }
  };
  const account = createAccountController(mount, { active: frontUp, changed: accountChanged, outdated: () => new Set([...observedVersions()].filter(([, value]) => value.outdated).map(([id]) => id)) });
  accountRead = !account.enabled;
  const confirmOf = (offer: RelayOffer): Extract<RelayShellState, { kind: "confirm" }> => {
    const view = account.state, signIn = account.signedInAs;
    const said = confirming || ((!accountRead || view?.kind === "signing-in") && !unanswered) ? "checking" as const
      : view?.kind !== "signed-in" ? undefined
      : signIn === undefined || (view.pcs === null && !unanswered) ? "checking" as const
      : !unanswered && view.error === null && account.directory.some((pc) => pc.server_id === offer.server_id) ? "listed" as const : "unlisted" as const;
    const state: Extract<RelayShellState, { kind: "confirm" }> = { kind: "confirm", offer, ...(said === undefined ? {} : { account: said }), ...(confirming && pressed !== undefined ? { pressed } : {}) };
    if (signIn !== undefined && (said === "listed" || said === "unlisted")) drawnFor.set(state, signIn);
    return state;
  };
  const waitForRead = (): void => {
    clearTimeout(readWait);
    // fixed wait: a sign-in or an account service that takes longer than this counts as one that did not answer
    readWait = setTimeout(() => {
      if (app !== null || confirming || shown?.kind !== "confirm" || shown.account !== "checking") return;
      unanswered = true;
      show(confirmOf(shown.offer));
    }, ACCOUNT_READ_WAIT_MS);
  };
  const readAgain = (offer: RelayOffer, after: (now: Extract<RelayShellState, { kind: "confirm" }>) => void, asked?: Extract<RelayShellState, { kind: "confirm" }>): void => {
    const mine = ++press;
    confirming = true;
    pressed = asked === undefined || asked.account === "checking" ? undefined : asked.account ?? "own";
    show(confirmOf(offer));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = account.reread().then(() => true, (error: unknown) => { console.warn("Ovis: the sign-in could not be read again", error instanceof Error ? error.name : error); return true; });
    // fixed wait: see ACCOUNT_READ_WAIT_MS
    const waited = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ACCOUNT_READ_WAIT_MS); });
    void Promise.race([read, waited]).then((answered) => {
      clearTimeout(timer);
      if (mine !== press) return;
      confirming = false;
      if (!answered) unanswered = true;
      if (app !== null || shown?.kind !== "confirm") return;
      const now = confirmOf(shown.offer);
      show(now);
      after(now);
    });
  };
  const sweep = createPcSweep(store, { active: frontUp, redraw: () => { if (shown) show(shown); } }, { ...(mount.checkPc ? { probe: mount.checkPc } : {}), ...(directSocket ? { directSocket } : {}) });
  const toFront = (): void => {
    if (shown?.kind === "ready") {
      const returnHash = sheetJoin?.returnHash ?? "";
      cancelAttempt(); sheetJoin = null; entry = { serverId: null, offer: null, damaged: false };
      window.history.replaceState(null, "", "/" + returnHash);
      void account.load(null).then(showFront);
      return;
    }
    cancelAttempt(); navigate("/" + (sheetJoin?.returnHash ?? ""));
  };
  const show = (state: RelayShellState): void => {
    shown = state;
    shell ??= (mount.createRoot ?? createRoot)(mount.container);
    shell.render(createElement(StrictMode, null, createElement(SettingsProvider, null, createElement(RelayShell, {
      state, scoped, iosTab, pcStatus: new Map(sweep.status), onCheckPcs: () => void sweep.check(), onCheckPc: (serverId: string) => void sweep.checkOne(serverId), onPair: confirmed, onRetry: retry, onCancel: cancel, onBack: toFront, onForget: forget,
      onForgetPc: async (serverId: string) => { account.cancelEnrollment(serverId); await forgetSavedPc(serverId, store); await account.refresh(); if (frontUp()) await showFront(); },
      onUpdate: updates.update, onMatch: match, onJoinInstead: joinInstead, onCodeStart: codeStart, onCodeSubmit: codeSubmit, onCodeMatch: codeMatch, onOpenPc: openPc, defaultRelay: GLOBAL_RELAY, meLabel: label,
      directoryRelays: account.directory, sheetJoin, continuedAccount: sheetJoin ? account.state : null, observedVersions: observedVersions(),
      ...(account.enabled ? { onSignIn: account.signIn, accountProviders: account.providers, onJoin: joinPc, onSignOut: account.signOut, onLeave: account.leave, onDeleteAccount: account.deleteAccount, ...(account.signedInAs?.sign_in_id === undefined ? {} : { accountSignIn: account.signedInAs.sign_in_id }), onRefreshAccount: () => account.refreshNow() } : {}),
    })))); account.armRefresh();
  };
  const showFront = async (): Promise<void> => {
    const before = shown;
    const devices = await store.list();
    if (shown !== before) return;
    show(devices.length ? { kind: "list", devices, account: account.state } : { kind: "empty", account: account.state });
    if (devices.length && !checked) { checked = true; void sweep.check(); }
  };
  const joinPc = (pc: MyPc, options: { typed?: boolean; sheet?: "new" | "join" } = {}): void => {
    if (!pc.join) return;
    const link = new URL(encodeOffer({ v: 1, server_id: pc.server_id, ...pc.join, name: pc.name }, window.location.origin));
    keepTypedJoin(options.typed ? pc.server_id : null);
    if (options.sheet) {
      keepSheetContext({ mode: options.sheet, server_id: pc.server_id, returnHash: dashboardHash(window.location.hash) });
      keepConfirmedPc(pc.server_id);
    }
    navigate(link.pathname + link.hash);
  };
  const failed = async (error: unknown, attempt: Attempt): Promise<void> => {
    if (last !== attempt) return;
    comparison = null;
    if (pairsAgainWithoutKey(error, { ...attempt, codeless: attempt.codeless === true })) {
      await store.remove(attempt.offer.server_id);
      if (last !== attempt) return;
      await connect({ ...attempt, refreshed: true });
      return;
    }
    let failure = failureOf(error, { code: attempt.code, paired: attempt.paired, compared: attempt.compared === true, codeless: attempt.codeless === true });
    if (failure === "revoked") {
      const saved = await store.get(attempt.offer.server_id);
      if (last !== attempt) return;
      if (saved?.pending_key && !attempt.retriedPending) {
        const { pending_key: pending, ...rest } = saved;
        await store.update(saved.server_id, () => ({ ...rest, private_key: pending.private_key, public_spki: pending.public_spki }));
        if (last !== attempt) return;
        await connect({ ...attempt, retriedPending: true });
        return;
      }
      if (saved?.introduced_at !== undefined && Date.now() - saved.introduced_at < INTRODUCED_GRACE_MS) failure = "not-added-yet";
    }
    if (forgetsDevice(failure)) await store.remove(attempt.offer.server_id).catch(() => undefined);
    if (last !== attempt) return;
    const mismatch = error instanceof ServerIdentityChangedError && error.saved !== undefined && error.offered !== undefined
      ? keyMismatch(attempt.offer.server_id, [{ key: error.saved, from: "saved" }, { key: error.offered, from: "link" }]) : null;
    show({ kind: "failed", failure, name: attempt.offer.name ?? null, detail: null, server_id: attempt.offer.server_id, ...(mismatch ? { mismatch } : {}) });
  };

  const connect = async (attempt: Attempt): Promise<void> => {
    attempt.compared = false;
    last = attempt;
    opening?.abort();
    const controller = new AbortController();
    opening = controller;
    show({ kind: "connecting", name: attempt.offer.name ?? null });
    let opened: RelayTransport;
    try {
      const prepared = await account.prepare(attempt.offer, controller.signal, consentOf(attempt));
      attempt.accountEnrollment = prepared.accountKey !== undefined;
      opened = await open(attempt.offer, {
        store, label, signal: controller.signal,
        ...prepared,
        ...(directSocket ? { directSocket, ...(directTailnet ? { directTailnet } : {}) } : {}),
        compare: (digits) => new Promise<void>((resolve) => {
          if (controller.signal.aborted) return;
          attempt.compared = true;
          comparison = { name: attempt.offer.name ?? null, digits, matched: resolve, typed: attempt.typed === true };
          show({ kind: "compare", name: comparison.name, digits: comparison.typed ? "" : digits, confirmed: false, challenge: ++challenge, ...(comparison.typed ? { typed: true } : {}) });
        }),
        onFatal: (error) => {
          if (transport !== opened || last === null) return;
          transport = null;
          app?.unmount();
          app = null;
          updates.cancel();
          void failed(error, last);
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ConsentChangedError && last === attempt) {
        if (!attempt.paired && entry.offer === attempt.offer) { last = null; opening = null; readAgain(attempt.offer, () => undefined); return; }
        if (attempt.paired) { await connect({ ...attempt, accountless: true }); return; }
      }
      await failed(error, attempt);
      return;
    }
    keepDeviceOnlyPc(attempt.accountless ? attempt.offer.server_id : null);
    keepConfirmedSignIn(attempt.signIn ? { server_id: attempt.offer.server_id, sign_in_id: attempt.signIn.sign_in_id ?? null } : null);
    if (controller.signal.aborted) { opened.close(); return; }
    opening = null;
    comparison = null;
    const { code, ...saved } = attempt.offer;
    const fresh = !attempt.paired || attempt.fresh === true;
    const enrolled: Attempt = { offer: saved, code: false, paired: true, accountEnrollment: attempt.accountEnrollment === true, retryEnrollment: attempt.retryEnrollment === true, ...(fresh ? { fresh: true, introducible: attempt.paired ? attempt.introducible === true : !attempt.code } : {}), ...(attempt.accountless ? { accountless: true } : {}), ...(attempt.signIn ? { signIn: attempt.signIn } : {}) };
    last = enrolled;
    if (code !== undefined && entry.offer !== null) entry = { ...entry, offer: null };
    transport = opened;
    await updates.admit(opened, enrolled);
  };


  const enterApp = (opened: RelayTransport, attempt: Attempt): void => {
    keepDeviceOnlyPc(null);
    keepConfirmedSignIn(null);
    setTransport(opened);
    shell?.unmount(); shell = null;
    app = mount.renderApp(); account.armRefresh();
    registerPending(attempt.offer.server_id);
    last = { ...attempt, fresh: false };
  };
  const openPc = (): void => { if (app === null && shown?.kind === "ready" && transport && last) enterApp(transport, last); };
  const enroll = (opened: RelayTransport, attempt: Attempt, settled?: () => void): void => {
    if (attempt.accountless) return;
    enrolling.add(opened);
    void account.enroll(opened, attempt.offer.server_id, attempt.fresh === true, attempt.fresh === true && attempt.introducible === true, { consent: consentOf(attempt), ...(settled ? { settled } : {}) }).then((enrollment) => {
      if (app === null && last === attempt && shown?.kind === "ready") show({ ...shown, enrollment });
    }, (error: unknown) => {
      console.warn("Ovis: this PC did not join the account yet", error instanceof Error ? error.name : error);
      if (app === null && last === attempt && shown?.kind === "ready") show({ ...shown, enrollment: "failed" });
    }).finally(() => { enrolling.delete(opened); if (transport !== opened) opened.close(); });
  };
  const updates = createUpdateFlow(mount.shellVersion ?? __APP_VERSION__, {
    show, failed, reload: mount.reload ?? (() => reloadPage(entry.serverId)),
    accepted: (opened, attempt) => {
      if (transport !== opened) return;
      if (attempt.retryEnrollment) { last = attempt; show({ kind: "ready", name: attempt.offer.name ?? null, server_id: attempt.offer.server_id, enrollment: attempt.accountEnrollment ? "pending" : "local" }); enroll(opened, attempt); return; }
      if (attempt.fresh && attempt.accountEnrollment && !attempt.accountless) {
        last = attempt;
        show({ kind: "connecting", name: attempt.offer.name ?? null });
        let waited: ReturnType<typeof setTimeout> | undefined;
        const enter = (): void => { clearTimeout(waited); if (transport !== opened || last !== attempt || app !== null) return; enterApp(opened, attempt); };
        // fixed wait: a PC that takes longer than this over the account's steps is opened without them
        waited = setTimeout(enter, ACCOUNT_STEPS_WAIT_MS);
        enroll(opened, attempt, enter);
        return;
      }
      enterApp(opened, attempt);
      enroll(opened, attempt);
    },
  }, store);
  const pair = (consent?: AccountSession | null): void => {
    if (entry.offer === null || shown?.kind !== "confirm") return;
    void connect({ offer: entry.offer, code: entry.offer.code !== undefined, paired: false, codeless: entry.offer.code === undefined, typed: typedJoin(entry.offer.server_id), ...(consent === null ? { accountless: true } : consent ? { signIn: consent } : {}) });
  };
  const confirmed = (): void => {
    const asked = shown, offer = entry.offer;
    if (offer === null || asked?.kind !== "confirm" || asked.account === "checking") return;
    if (sheetJoin !== null || !account.enabled) { pair(); return; }
    const named = drawnFor.get(asked);
    if (asked.account !== undefined && named === undefined) { show(confirmOf(offer)); return; }
    readAgain(offer, (now) => {
      if (entry.offer !== offer || now.offer !== offer || now.account !== asked.account) return;
      const holds = drawnFor.get(now);
      if (named === undefined ? holds !== undefined : holds === undefined || !sameSignIn(named, holds)) return;
      pair(named ?? null);
    }, asked);
  };
  const consentOf = (attempt: Attempt): AccountSession | null | undefined => attempt.accountless ? null : attempt.signIn;
  const cancelAttempt = (): void => { press++; confirming = false; comparison = null; last = null; opening?.abort(); opening = null; updates.cancel(); if (transport && !enrolling.has(transport)) transport.close(); transport = null; };
  const retry = (): void => {
    if (shown?.kind === "ready" && shown.enrollment === "failed" && transport && last) { show({ ...shown, enrollment: "pending" }); enroll(transport, last); return; }
    if (last === null || !(shown?.kind === "failed" || shown?.kind === "outdated" || shown?.kind === "compare" && shown.wrong)) return;
    updates.cancel(); transport?.close(); transport = null;
    void connect({ ...last, compared: false });
  };
  const match = (typed?: string): void => {
    const current = comparison;
    if (current === null) return;
    comparison = null;
    if (current.typed && typed !== current.digits) {
      opening?.abort(); opening = null;
      show({ kind: "compare", name: current.name, digits: "", confirmed: false, typed: true, wrong: true, challenge });
      return;
    }
    keepTypedJoin(null);
    show({ kind: "compare", name: current.name, digits: current.typed ? "" : current.digits, confirmed: true, typed: current.typed, challenge });
    current.matched();
  };
  const joinInstead = (): void => {
    const current = comparison;
    if (current === null || !current.typed) return;
    comparison = { ...current, typed: false };
    if (last !== null) last.typed = false;
    keepTypedJoin(null);
    if (sheetJoin !== null) { sheetJoin = { ...sheetJoin, mode: "join" }; keepSheetContext(sheetJoin); }
    show({ kind: "compare", name: current.name, digits: current.digits, confirmed: false, challenge });
  };
  const codeStart = (): void => { cancelAttempt(); codeOffer = null; show({ kind: "code-entry", failure: null }); };
  const codeSubmit = (input: string): void => {
    if (shown?.kind !== "code-entry") return;
    const controller = new AbortController(); opening = controller; codeOffer = null;
    show({ kind: "code-looking" });
    findByCode(input, { signal: controller.signal }).then((offer) => {
      if (controller.signal.aborted) return;
      codeOffer = offer; show({ kind: "code-compare", offer });
    }, (error: unknown) => { if (!controller.signal.aborted) show({ kind: "code-entry", failure: error instanceof TypedCodeError ? error.failure : "unreachable" }); });
  };
  const codeMatch = (): void => { const offer = codeOffer; codeOffer = null; if (offer) { keepConfirmedPc(offer.server_id); navigate(encodeOffer(offer, window.location.origin)); } };
  const cancel = (): void => {
    if (shown?.kind === "ready") { toFront(); return; }
    cancelAttempt(); keepTypedJoin(null); codeOffer = null;
    if (scoped) toFront(); else void showFront();
  };
  const forget = (): void => {
    const serverId = last?.offer.server_id ?? entry.serverId, name = last?.offer.name ?? null;
    cancelAttempt(); entry = { ...entry, offer: null };
    if (serverId !== null && deviceOnlyPc() === serverId) keepDeviceOnlyPc(null);
    if (serverId !== null && confirmedSignIn()?.server_id === serverId) keepConfirmedSignIn(null);
    void (async () => { if (serverId !== null) { account.cancelEnrollment(serverId); await forgetSavedPc(serverId, store); } show({ kind: "forgotten", name }); })();
  };
  const arrived = (): boolean => {
    const confirmedPc = takeConfirmedPc();
    if (entry.damaged) { show({ kind: "failed", failure: "bad-offer", name: null, detail: null }); return true; }
    if (entry.offer !== null && forgedOffer(entry.offer)) {
      show({ kind: "forged", name: entry.offer.name ?? null, mismatch: keyMismatch(entry.offer.server_id, [{ key: entry.offer.server_public_key, from: "link" }]) });
      entry = { ...entry, offer: null };
      return true;
    }
    if (entry.offer !== null) {
      sheetJoin = sheetContext(entry.offer.server_id);
      if (sheetJoin?.returnHash) window.history.replaceState(null, "", new URL(mount.entryUrl).pathname + sheetJoin.returnHash);
      if (sheetJoin || !accountRead) void account.load(null).finally(() => { if (!accountRead) void accountChanged(); });
      show(confirmOf(entry.offer));
      if (account.enabled && sheetJoin === null) waitForRead();
      if (confirmedPc === entry.offer.server_id && (sheetJoin !== null || entry.offer.code !== undefined)) pair();
      return true;
    }
    return false;
  };

  window.addEventListener("hashchange", () => {
    if (app !== null || window.location.hash === "") return;
    const next = shellEntry(takeEntryUrl(window));
    if (next.offer === null && !next.damaged) return;
    cancelAttempt();
    sheetJoin = null;
    entry = next;
    arrived();
  });


  const deviceOnly = deviceOnlyPc(), namedSignIn = confirmedSignIn();
  if (arrived()) return;
  if (entry.serverId !== null) {
    const saved = await store.get(entry.serverId);
    if (saved === undefined) show({ kind: "empty" });
    else if (forgedOffer(offerOf(saved))) show({ kind: "failed", failure: "identity-changed", name: saved.name ?? null, detail: null, mismatch: keyMismatch(saved.server_id, [{ key: saved.server_public_key, from: "saved" }]) });
    else {
      const named = namedSignIn?.server_id === saved.server_id ? namedSignIn : null;
      const now = named === null || named.sign_in_id === null ? undefined : await account.stored();
      const signIn = now !== undefined && now.sign_in_id === named?.sign_in_id ? now : undefined;
      const accountless = deviceOnly === saved.server_id || (named !== null && signIn === undefined);
      await connect({ offer: offerOf(saved), code: false, paired: saved.device_id !== null, retryEnrollment: enrollmentOf(saved) === "failed", ...(accountless ? { accountless: true } : signIn ? { signIn } : {}) });
    }
    return;
  }

  await showFront();
  await account.load(account.enabled ? signInReturn(new URL(mount.entryUrl).hash) : null);
}
