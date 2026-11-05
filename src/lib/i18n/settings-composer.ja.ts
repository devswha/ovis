/**
 * Japanese for the settings keys of Settings → Chat → Composer's optional buttons and chips, of Settings → Terminal → Split into rows and columns, and of Settings → Shortcuts → herdr prefix keys: the rest of the
 * settings part (./settings.ja.ts), kept apart so each file stays short. Both files are the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_COMPOSER_JA: Record<string, string> = {
  "New tab button": "新しいタブボタン",
  "A button in the message box opens New tab with an agent… on the pane's workspace. The tab menu offers it either way.": "入力欄のボタンで、このペインのワークスペースに「エージェント付きの新しいタブ…」を開きます。タブメニューからはいつでも開けます。",
  "Artifacts chip": "アーティファクトチップ",
  "A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool.": "Claude Code のペインの入力欄に、セッションが Artifact ツールで公開したページの一覧を出すチップを表示します。",
  "Side conversations chip (experimental)": "サイド会話チップ（実験的）",
  "A chip in an OMP pane's message box lists the side conversations its session saved with /btw.": "OMP ペインの入力欄に、セッションが /btw で保存したサイド会話の一覧を開くチップを表示します。",
  "Paste and send button": "貼り付けて送信ボタン",
  "A button in the empty message box sends the text copied on this device as a message.": "空の入力欄のボタンで、このデバイスでコピーしたテキストをメッセージとして送ります。",
  "Split into rows and columns": "行と列に分割",
  "Drop a pane on the edge of another in the split view to open it beside, above or below that pane, up to four at once, and drag the line between two panes to resize them. Off: the split view keeps two halves side by side.": "分割表示でペインを別のペインの端にドロップすると、そのペインの横、上、下に開きます。同時に4つまで開け、2つのペインの間の線をドラッグするとサイズを変えられます。オフ：分割表示は左右2つのままです。",
  "Go to tab 1-9": "1〜9番目のタブへ移動",
  "Prefix": "プレフィックス",
  "This PC's server does not report herdr's keys yet.": "このPCのサーバーはまだherdrのキーを報告していません。",
  "Use herdr's prefix keys": "herdrのプレフィックスキーを使う",
  "herdr prefix keys": "herdrのプレフィックスキー",
  "herdr's prefix in its config.toml cannot be used here, so no key is taken.": "config.tomlのherdrプレフィックスはここでは使えないため、キーは取得しません。",
  "herdr's prefix, then a key herdr's config.toml on this PC binds, runs that action here: the ones listed below. The prefix no longer reaches the pane: press it twice to send it. Fields, dialogs and IME input keep their keys.": "herdrのプレフィックスに続けて、このPCのherdr config.tomlが割り当てたキーを押すと、下に挙げた操作がここで実行されます。プレフィックスはペインに届かなくなります。送るには2回押してください。入力欄、ダイアログ、IME入力はキーをそのまま受け取ります。",
};
