import { useCallback, useEffect, useState } from "react";

import type { DeviceNotice, NoticeAnswer, NoticeSeen } from "../../shared/account-devices-api.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { noticeSeen, withNoticeAcked, withNoticeDecided, withNoticeReplay, type PcNotices } from "./deviceNotices.ts";

/** What this hook needs of a PC's socket (HerdrSocket): its frames, and a send that only a PC offering it takes. */
export interface NoticeSocket {
  on(handler: (message: ServerMessage) => void): () => void;
  onDisconnect(handler: () => void): () => void;
  accountOpensAll(): boolean;
  sendNotice(message: NoticeSeen | NoticeAnswer): boolean;
}

/**
 * Each PC's journal notices (device table P15, T57): kept per PC as its socket replays and adds them, acknowledged
 * up to the newest one shown once that PC takes it, and dismissed here only; a dismiss sends nothing, and an open
 * admission is not dismissed (it stays until its PC says it was decided).
 */
export function useDeviceNotices(sockets: readonly { id: string; socket: NoticeSocket }[], selectedPcId: string) {
  const [byPc, setByPc] = useState<ReadonlyMap<string, PcNotices>>(new Map());
  useEffect(() => {
    const offs = sockets.flatMap(({ id, socket }) => {
      const clear = () => setByPc((current) => {
        const notices = current.get(id);
        if (notices === undefined || (notices.notices.length === 0 && notices.cut === 0)) return current;
        return new Map(current).set(id, { ...notices, notices: [], cut: 0 });
      });
      return [socket.onDisconnect(clear), socket.on((message) => {
        if (!socket.accountOpensAll()) {
          if (message.type === "features" || message.type === "snapshot") clear();
          return;
        }
        if (message.type !== "device-notice-replay" && message.type !== "device-notice") return;
        setByPc((current) => {
          const was = current.get(id);
          const replay = message.type === "device-notice-replay" ? message.replay : { notices: [message.notice], cut: was?.cut ?? 0 };
          return new Map(current).set(id, withNoticeReplay(was, replay));
        });
      })];
    });
    return () => { for (const off of offs) off(); };
  }, [sockets]);
  const selectedSocket = sockets.find(({ id }) => id === selectedPcId)?.socket;
  const shown = byPc.get(selectedPcId);
  const seenSeq = shown === undefined ? undefined : noticeSeen(shown)?.seq;
  useEffect(() => {
    if (seenSeq === undefined || !selectedSocket?.sendNotice({ type: "notice-seen", seq: seenSeq })) return;
    setByPc((current) => {
      const notices = current.get(selectedPcId);
      if (notices === undefined) return current;
      return new Map(current).set(selectedPcId, withNoticeAcked(notices, seenSeq));
    });
  }, [seenSeq, selectedPcId, selectedSocket]);
  const dismiss = useCallback((id: string, notice: DeviceNotice) => {
    setByPc((current) => {
      const notices = current.get(id);
      if (notices === undefined || !notices.notices.some((item) => item.id === notice.id && !item.open)) return current;
      return new Map(current).set(id, withNoticeDecided(notices, notice.id));
    });
  }, []);
  return { byPc, dismiss };
}
