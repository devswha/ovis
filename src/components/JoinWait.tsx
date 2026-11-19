import "./JoinWait.css";

import type { HoldState } from "../../shared/account-devices-api.ts";
import { holdWaitMs } from "../lib/relay/joinHold.ts";
import { useT } from "../lib/i18n.ts";

/** The new device's wait on one PC (device table P17, T53, T67): that PC's own deadline, nothing when it holds nothing. */
export function JoinWait({ pc, hold, now }: { pc: string; hold: HoldState | undefined; now: number }) {
  const t = useT();
  if (hold === undefined) return null;
  const left = holdWaitMs(hold, now);
  const line = left !== null ? t("{pc} opens in {seconds} s", { pc, seconds: Math.ceil(left / 1000) })
    : hold.reason === "join_hold" ? t("{pc} is telling your other devices first", { pc })
    : hold.reason === "frozen" ? t("{pc} holds this device after a Not me from another device", { pc })
    : t("{pc} is checking your account first", { pc });
  return (
    <div className="join-wait" role="status">
      <span>{line}</span>
      {hold.reason === "join_hold" && <span className="settings-hint">{t("Your other devices are told first. One of them can let this device in now.")}</span>}
    </div>
  );
}

/** "It's me" on an undecided admission (device table T53): one press, held while it goes to each PC. */
export function ItsMeButton({ sending, onPress }: { sending: boolean; onPress: () => void }) {
  const t = useT();
  return <button type="button" className="btn" disabled={sending} onClick={onPress}>{t("It's me")}</button>;
}
