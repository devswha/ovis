/** T51, T60, T65: answer an admission with the current sign-in's key and show only PC-authenticated receipts. */
import { useEffect, useRef, useState } from "react";
import type { DeviceNotice } from "../../shared/account-devices-api.ts";
import { LOCAL_MACHINE, machinePath, type Machine } from "../../shared/machines.ts";
import { canBlockAdmission, notMeBlocks, sendBlocks, type FleetBlock, type OwnKey } from "../lib/account/fleet-block.ts";
import { answerOnPc, notMeTransports } from "../lib/account/noticeAnswer.ts";
import { ACCOUNT_SIGN_OUT_EVENT, indexedAccountService, sameSignIn } from "../lib/account/service.ts";
import { indexedAccountStore, type AccountSession } from "../lib/account/store.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import type { MachineSessionRegistry } from "../lib/machineSession.ts";
import { itsMeAnswer, withItsMeAnswered, withItsMeSent, type ItsMeWaiting } from "../lib/relay/joinHold.ts";
import { useDeviceNotices, type NoticeSocket } from "../lib/useDeviceNotices.ts";
import { BlockOutcomes, NotMeButton } from "./BlockOutcomes.tsx";
import { DeviceNotices } from "./DevicePairedNotice.tsx";
import { ItsMeButton } from "./JoinWait.tsx";

const ANSWER_TIMEOUT_MS = 5000;

async function noticeIdentity(session: AccountSession | undefined): Promise<{ readonly account: string; readonly key: OwnKey | null } | null> {
  if (session === undefined) return null;
  const kept = await indexedAccountStore.get("signin_key");
  const key = kept !== undefined && kept.no !== null && session.account === kept.account && session.sign_in_id === kept.sign_in_id
    ? { ...kept.key, no: kept.no } : null;
  return { account: session.account, key };
}

type NoticeFleet = {
  readonly machines: readonly Machine[];
  readonly pageServerId: string | undefined;
};

function AdmissionActions({ notice, pc, socket, fleet, own }: {
  readonly notice: DeviceNotice;
  readonly pc: Machine;
  readonly socket: NoticeSocket;
  readonly fleet: NoticeFleet;
  readonly own: Awaited<ReturnType<typeof noticeIdentity>>;
}) {
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ readonly fleet: FleetBlock; readonly names: ReadonlyMap<string, string> } | null>(null);
  const canAnswer = own !== null && notice.account === own.account && notice.kind === "admit" && notice.open && socket.accountOpensAll();
  const canBlock = canAnswer && own.key !== null && canBlockAdmission(notice, own.key);
  const waiting = useRef<ItsMeWaiting>(new Map());

  const confirm = async () => {
    if (!canAnswer || inFlight.current || result !== null) return;
    const pcId = pc.server_id ?? pc.relay?.server_id ?? pc.id;
    inFlight.current = true;
    setSending(true);
    try {
      const started = await indexedAccountStore.get("session");
      if (started === undefined || started.account !== notice.account) return;
      waiting.current = withItsMeSent(waiting.current, notice.id, [pcId]);
      // The notice ID is PC-local. Never send it to another PC or via the block records route.
      for (let tries = 0; tries < 2 && waiting.current.get(notice.id)?.has(pcId); tries++) {
        const current = await indexedAccountStore.get("session");
        if (current === undefined || current.account !== notice.account || !sameSignIn(started, current) || !socket.accountOpensAll()) break;
        const [outcome] = await Promise.allSettled([answerOnPc(socket, { notice, answer: itsMeAnswer(notice) }, ANSWER_TIMEOUT_MS)]);
        if (outcome.status === "fulfilled") waiting.current = withItsMeAnswered(waiting.current, notice.id, pcId);
      }
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      console.warn("Ovis: could not read the sign-in for an admission answer", error.name);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const press = async () => {
    if (!canBlock || inFlight.current || result !== null) return;
    inFlight.current = true;
    setSending(true);
    try {
      const session = await indexedAccountService.session();
      if (session === undefined) return;
      const current = await noticeIdentity(session);
      if (current === null || current.key === null || current.account !== notice.account || !socket.accountOpensAll()) return;
      const blocks = await notMeBlocks(notice, current.key);
      if (blocks.length === 0) return;

      const serverIdOf = (machine: Machine) =>
        (machine.id === LOCAL_MACHINE ? fleet.pageServerId : undefined) ?? machine.server_id ?? machine.relay?.server_id;
      const pagePc = fleet.machines.find((machine) => machine.id === LOCAL_MACHINE);
      const pageId = pagePc === undefined ? undefined : serverIdOf(pagePc);
      const ownServerId = serverIdOf(pc);
      const ownId = ownServerId ?? pc.id;
      const rows = new Map([[ownId, pc]]);
      for (const machine of fleet.machines) {
        const serverId = serverIdOf(machine);
        const key = serverId ?? machine.id;
        if (!rows.has(key)) rows.set(key, machine);
      }
      const post = (id: string) => (path: string, body: unknown) => {
          const machine = rows.get(id);
          if (machine === undefined) return Promise.reject(new RangeError("Unknown block destination"));
          return apiFetch(machinePath(machine.id, path.slice("/api/".length)), {
            method: "POST",
            headers: { "content-type": "application/json", "x-herdr-machine": "1" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
          });
      };
      const routes = notMeTransports(notice, ownId, [...rows.keys()], {
        socket: () => socket,
        post,
        // The page's carrier can authenticate its own records reply, not a roster PC's.
        channel: (id) => id === pageId && rows.get(id)?.id === LOCAL_MACHINE ? post(id) : undefined,
        timeoutMs: ANSWER_TIMEOUT_MS,
      });
      // The app's one carrier (native or relay) is to the page's PC. Other roster sockets are proxied.
      if (pc.id !== LOCAL_MACHINE || ownServerId === undefined) {
        const answer = routes.pcs.get(ownId);
        if (answer !== undefined) routes.relayed = new Map([[ownId, answer], ...routes.relayed]);
        routes.pcs.delete(ownId);
      }
      const service = indexedAccountService.forSignIn(session);
      const sent = await sendBlocks(blocks, {
        ...routes,
        service: async (records) => { await Promise.all(records.map((record) => service.postSafetyRecord(record))); },
      });
      setResult({ fleet: sent, names: new Map([...rows].map(([id, machine]) => [id, machine.name])) });
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      console.warn("Ovis: could not sign a device block", error.name);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  if (result !== null) return <BlockOutcomes outcomes={[...result.fleet.outcomes.values()]} names={result.names} />;
  return canAnswer ? <>
    <ItsMeButton sending={sending} onPress={confirm} />
    {canBlock && <NotMeButton sending={sending} onPress={press} />}
  </> : null;
}

/** Subscribe alongside the App's roster hooks so opening the pane does not miss a notice replay. */
export function useAccountDeviceNotices({ machines, machineSessions, selectedMachineId, pageServerId }: NoticeFleet & {
  readonly machineSessions: MachineSessionRegistry;
  readonly selectedMachineId: string;
}) {
  const sockets = machines.flatMap(({ id }) => {
    const socket = machineSessions.peek(id)?.socket;
    return socket === undefined ? [] : [{ id, socket }];
  });
  const feed = useDeviceNotices(sockets, selectedMachineId);
  const shown = feed.byPc.get(selectedMachineId);
  const [own, setOwn] = useState<Awaited<ReturnType<typeof noticeIdentity>>>(null);
  useEffect(() => {
    if (!shown?.notices.some((notice) => notice.kind === "admit" && notice.open)) return;
    let live = true;
    let readVersion = 0;
    const read = () => {
      const version = ++readVersion;
      void indexedAccountStore.get("session").then(noticeIdentity).then(
        (key) => { if (live && version === readVersion) setOwn(key); },
        () => { if (live && version === readVersion) setOwn(null); },
      );
    };
    read();
    window.addEventListener("focus", read);
    window.addEventListener(ACCOUNT_SIGN_OUT_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
      window.removeEventListener(ACCOUNT_SIGN_OUT_EVENT, read);
    };
  }, [shown?.notices]);

  const pc = machines.find((machine) => machine.id === selectedMachineId);
  const socket = sockets.find(({ id }) => id === selectedMachineId)?.socket;
  if (pc === undefined || shown === undefined) return null;
  return (
    <DeviceNotices key={pc.id} pc={pc.name} notices={shown.notices} cut={feed.cut}
      onDismiss={(notice) => feed.dismiss(pc.id, notice)} onShown={feed.acknowledgeShown}
      actions={(notice) => socket === undefined ? null : <AdmissionActions notice={notice} pc={pc} socket={socket} fleet={{ machines, pageServerId }} own={own} />}
    />
  );
}
