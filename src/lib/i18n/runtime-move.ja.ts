/**
 * Japanese for the keys only the move to herdr-core uses:
 * components/RuntimeMove.tsx, components/RuntimeMoveViews.tsx, lib/runtimeMove.ts.
 * Register and fixed terms follow ../i18n.ja.ts; a key another feature also uses goes there.
 */
export const RUNTIME_MOVE_JA: Record<string, string> = {
  "Move everything to herdr-core": "herdr-core にすべて移す",
  "Every workspace, tab and agent reopens on herdr-core, all at once.": "すべてのワークスペース・タブ・エージェントを一度に herdr-core で開き直します。",
  "Move…": "移す…",
  "Waiting…": "待機中…",
  "Moving…": "移動中…",

  "Continues the same conversation": "同じ会話を続ける",
  "Starts new (no conversation found)": "新しく開始（会話情報なし）",
  "New shell in the same folder": "同じフォルダーに新しいシェル",
  "End it yourself": "手動で終了してください",
  "Answering": "応答中",
  "Waiting for an answer": "回答待ち",
  "A command is running": "コマンド実行中",
  "{command} running": "{command} 実行中",
  "Text left half-typed in the input of {agents} is lost.": "{agents} の入力欄に書きかけの文字は失われます。",
  "Scrollback and programs running in shells do not come along. herdr itself stays as it is.": "過去の出力（スクロールバック）とシェルで動いていたプログラムは移りません。herdr 自体はそのまま残ります。",
  "Move everything": "すべて移す",
  "Move everything once all work is done": "作業がすべて終わったら一度に移す",

  "One pane is at work. Everything moves at once when it is done.": "1 つのペインが作業中です。終わったら一度に移します。",
  "{n} panes are at work. Everything moves at once when they are done.": "{n} 個のペインが作業中です。すべて終わったら一度に移します。",
  "End a program in a shell (Ctrl+C) or an agent marked above yourself; the move then goes on by itself.": "シェルのプログラム（Ctrl+C）や上に示したエージェントは手動で終了してください。終わると自動で進みます。",
  "Waiting for work to finish…": "作業の終了を待っています…",

  "Ending the agents in herdr": "herdr のエージェントを終了中",
  "Rebuilding the workspaces, tabs and splits on herdr-core": "herdr-core にワークスペース・タブ・分割を再作成中",
  "Reopening the agents on herdr-core": "herdr-core でエージェントを開き直し中",
  "Switching Ovis to herdr-core": "Ovis を herdr-core に切り替え中",

  "Now running on herdr-core. To go back to herdr, switch the runtime again.": "herdr-core で動いています。herdr に戻すには、ランタイムをもう一度切り替えてください。",
  "Could not move, so everything was put back as it was.": "移せなかったため、元の状態に戻しました。",
  "Not reopened in herdr:": "herdr で開き直せなかったもの:",
};
