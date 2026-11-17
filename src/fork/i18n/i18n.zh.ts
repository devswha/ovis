/**
 * Keys only this fork's Settings rows use: components/ForkSettingsRows.tsx.
 * Register and fixed terms follow ../i18n.zh.ts; a key another feature also uses goes there.
 */
import { FORK_I18N } from "./i18n.ts";
import { FORK_FEATURE_I18N } from "./featureI18n.ts";
import { GITHUB_I18N } from "../github/githubI18n.ts";
import { NOTES_I18N } from "../notes/notesI18n.ts";

export const FORK_ZH: Record<string, string> = {
  ...FORK_FEATURE_I18N.zh,
  ...GITHUB_I18N.zh,
  ...NOTES_I18N.zh,
  ...FORK_I18N.zh,
  "Follow Omarchy": "跟随 Omarchy",
  "This device has not sent its Omarchy theme. Its theme-set hook (scripts/omarchy-theme-hook.sh) sends it whenever the theme changes.": "这台设备还没有发送它的 Omarchy 主题。它的 theme-set 钩子 (scripts/omarchy-theme-hook.sh) 会在每次换主题时发送。",
  "Draws this device in its Omarchy theme, {name}, and changes with it. Only on this device: the themes above stay for the others.": "用这台设备的 Omarchy 主题 {name} 绘制界面，并随它变化。只在这台设备上：其他设备保留上面的主题。",
  "Voice": "声音",
  "American": "美式",
  "British": "英式",
  "The speaker button under a reply reads it on this device. Kokoro speaks on the server, free and offline; the first time it takes a few minutes to set up.": "点回复下方的扬声器按钮，即在此设备上朗读。语音由服务器上的 Kokoro 免费离线生成，首次使用需要几分钟准备。",
  "Same as Pi": "与 Pi 相同",
  "The voice of a live call with a Pi pane, from the next call on. Same as Pi uses the voice set in Pi's /openai-settings.": "与 Pi 窗格实时通话时使用的声音，从下一次通话开始生效。“与 Pi 相同”使用 Pi 的 /openai-settings 中设置的声音。",
  "Open work while the agent runs": "代理运行时展开工作",
  "Off, a running turn shows only its Working… row until tapped": "关闭后，运行中的轮次在点按前只显示“工作中…”一行",
};
