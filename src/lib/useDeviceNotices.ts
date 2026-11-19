import { useCallback, useEffect, useState } from "react";

import type { DeviceNotice, NoticeAnswer, NoticeSeen } from "../../shared/account-devices-api.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { noticeSeen, withNoticeAcked, withNoticeDecided, withNoticeReplay, type PcNotices } from "./deviceNotices.ts";

/** What this hook needs of a PC's socket (HerdrSocket): its frames, and a send that only a PC offering it takes. */
export interface NoticeSocket {
  on(handler: (message: ServerMessage) => void): () => void;
  sendNotice(message: NoticeSeen | NoticeAnswer): boolean;
}

/**
 * Each PC's journal notices (device table P15, T57): kept per PC as its socket replays and adds them, acknowledged
 * up to the newest one shown once that PC takes it, and dismissed here only; a dismiss sends nothing, and an open
 * admission is not dismissed (it stays until its PC says it was decided).
 */
export function useDeviceNotices(sockets: readonly { id: string; socket: NoticeSocket }[]) {
  const [byPc, setByPc] = useState<ReadonlyMap<string, PcNotices>>(new Map());
  const key = sockets.map(({ id }) => id).join(" ");
  useEffect(() => {
    const offs = sockets.map(({ id, socket }) => socket.on((message) => {
      if (message.type !== "device-notice-replay" && message.type !== "device-notice") return;
      setByPc((current) => {
        const was = current.get(id);
        const replay = message.type === "device-notice-replay" ? message.replay : { notices: [message.notice], cut: was?.cut ?? 0 };
        return new Map(current).set(id, withNoticeReplay(was, replay));
      });
    }));
    return () => { for (const off of offs) off(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let acked: Map<string, PcNotices> | null = null;
    for (const { id, socket } of sockets) {
      const notices = byPc.get(id);
      const seen = notices === undefined ? null : noticeSeen(notices);
      if (notices === undefined || seen === null || !socket.sendNotice(seen)) continue;
      (acked ??= new Map(byPc)).set(id, withNoticeAcked(notices, seen.seq));
    }
    if (acked !== null) setByPc(acked);
  }, [byPc, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const dismiss = useCallback((id: string, notice: DeviceNotice) => {
    if (notice.open) return;
    setByPc((current) => {
      const notices = current.get(id);
      return notices === undefined ? current : new Map(current).set(id, withNoticeDecided(notices, notice.id));
    });
  }, []);
  return { byPc, dismiss };
}
