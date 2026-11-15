/**
 * Keys only this fork's Settings rows use: components/ForkSettingsRows.tsx.
 * Register and fixed terms follow ../i18n.ja.ts; a key another feature also uses goes there.
 */
import { FORK_I18N } from "./i18n.ts";
import { FORK_FEATURE_I18N } from "./featureI18n.ts";

export const FORK_JA: Record<string, string> = {
  ...FORK_FEATURE_I18N.ja,
  ...FORK_I18N.ja,
  "Context circle": "コンテキストリング",
  "A ring beside the model shows how full its context is. Tap it for the numbers.": "モデルの横のリングがコンテキストの使用量を示します。タップすると数値を表示します。",
  "Follow Omarchy": "Omarchy に追従",
  "This device has not sent its Omarchy theme. Its theme-set hook (scripts/omarchy-theme-hook.sh) sends it whenever the theme changes.": "このデバイスはまだ Omarchy のテーマを送っていません。theme-set フック (scripts/omarchy-theme-hook.sh) がテーマを変えるたびに送ります。",
  "Draws this device in its Omarchy theme, {name}, and changes with it. Only on this device: the themes above stay for the others.": "このデバイスを Omarchy のテーマ {name} で表示し、テーマの変更に追従します。このデバイスだけ: ほかのデバイスは上のテーマのままです。",
  "Voice": "声",
  "American": "アメリカ英語",
  "British": "イギリス英語",
  "The speaker button under a reply reads it on this device. Kokoro speaks on the server, free and offline; the first time it takes a few minutes to set up.": "返信の下のスピーカーボタンで、このデバイスで読み上げます。音声はサーバー上の Kokoro が無料・オフラインで作ります。初回は準備に数分かかります。",
  "Same as Pi": "Piと同じ",
  "The voice of a live call with a Pi pane, from the next call on. Same as Pi uses the voice set in Pi's /openai-settings.": "Piペインとのライブ通話の声です。次の通話から使われます。「Piと同じ」はPiの/openai-settingsで設定した声を使います。",
  "Open work while the agent runs": "作業中は作業を開く",
  "Off, a running turn shows only its Working… row until tapped": "オフにすると、実行中のターンはタップするまで「作業中…」の行だけを表示します",
};
