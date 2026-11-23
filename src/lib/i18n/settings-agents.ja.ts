/**
 * Japanese for the settings keys of Settings → Appearance's agent rows: the rest of the settings part
 * (./settings.ja.ts), kept apart so each file stays short. All these files are the one settings
 * part, so a key lives in only one of them; ./settings.ja.ts's header lists the settings files and the register.
 */
export const SETTINGS_AGENTS_JA: Record<string, string> = {
  "OpenCode: subagent ends from their session": "OpenCode: サブエージェントの終了を親セッションから読む",
  "OMP on macOS herdr-core: chat from the session it holds open": "OMP（macOS の herdr-core）: 開いているセッションからチャットを読む",
  "Notes your agents get for reference. Only notes you confirmed go to them.": "エージェントに参考として渡すメモです。確認したものだけを渡します。",
  "notes remember agents confirm": "メモ 記憶 エージェント 確認",
};
