/**
 * Korean for the settings keys of Settings → Appearance's agent rows: the rest of the settings part
 * (./settings.ko.ts), kept apart so each file stays short. All these files are the one settings
 * part, so a key lives in only one of them; ./settings.ko.ts's header lists the settings files and the register.
 */
export const SETTINGS_AGENTS_KO: Record<string, string> = {
  "OpenCode: subagent ends from their session": "OpenCode 완료 확인을 상위 세션에서 받기",
  "OMP on macOS herdr-core: chat from the session it holds open": "OMP (macOS herdr-core): 열어 둔 세션에서 채팅 읽기",
  "Notes your agents get for reference. Only notes you confirmed go to them.": "에이전트에게 참고로 주는 메모입니다. 확인한 메모만 넣습니다.",
  "notes remember agents confirm": "메모 기억 에이전트 확인",
};
