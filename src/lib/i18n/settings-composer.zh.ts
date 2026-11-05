/**
 * Chinese for the settings keys of Settings → Chat → Composer's optional buttons and chips, of Settings → Terminal → Split into rows and columns, and of Settings → Shortcuts → herdr prefix keys: the rest of the
 * settings part (./settings.zh.ts), kept apart so each file stays short. Both files are the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_COMPOSER_ZH: Record<string, string> = {
  "New tab button": "新标签页按钮",
  "A button in the message box opens New tab with an agent… on the pane's workspace. The tab menu offers it either way.": "输入框中的按钮可在该面板的工作区打开“带代理的新标签页…”。标签页菜单中始终可用。",
  "Artifacts chip": "Artifact 标签",
  "A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool.": "在 Claude Code 面板的输入框中显示一个标签，列出该会话用 Artifact 工具发布的页面。",
  "Side conversations chip (experimental)": "旁支对话标签（实验性）",
  "A chip in an OMP pane's message box lists the side conversations its session saved with /btw.": "在 OMP 窗格的输入框中显示一个标签，列出该会话用 /btw 保存的旁支对话。",
  "Paste and send button": "粘贴并发送按钮",
  "A button in the empty message box sends the text copied on this device as a message.": "空输入框中的按钮会把在此设备上复制的文本作为消息发送。",
  "Split into rows and columns": "按行和列拆分",
  "Drop a pane on the edge of another in the split view to open it beside, above or below that pane, up to four at once, and drag the line between two panes to resize them. Off: the split view keeps two halves side by side.": "在拆分视图中把窗格放到另一个窗格的边缘，即可在它的旁边、上方或下方打开，最多同时四个；拖动两个窗格之间的线可调整大小。关闭时，拆分视图保持左右两半。",
  "Go to tab 1-9": "转到第 1-9 个标签页",
  "Prefix": "前缀键",
  "This PC's server does not report herdr's keys yet.": "此 PC 的服务器尚未报告 herdr 的按键。",
  "Use herdr's prefix keys": "使用 herdr 前缀键",
  "herdr prefix keys": "herdr 前缀键",
  "herdr's prefix in its config.toml cannot be used here, so no key is taken.": "config.toml 中的 herdr 前缀键无法在此使用，因此不会占用任何按键。",
  "herdr's prefix, then a key herdr's config.toml on this PC binds, runs that action here: the ones listed below. The prefix no longer reaches the pane: press it twice to send it. Fields, dialogs and IME input keep their keys.": "按下 herdr 前缀键后，再按此 PC 的 herdr config.toml 绑定的键，即可在这里执行下方列出的操作。前缀键将不再发送到窗格：按两次即可发送。输入框、对话框和输入法输入保留其按键。",
};
