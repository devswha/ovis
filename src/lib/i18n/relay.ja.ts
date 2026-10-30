/**
 * Japanese for the keys only the hosted relay shell uses: components/RelayShell.tsx.
 * Register and fixed terms follow ../i18n.ja.ts; a key another feature also uses goes there.
 */
export const RELAY_JA: Record<string, string> = {
  "this PC": "このPC",
  "Your PCs": "あなたのPC",
  "Unnamed PC": "名前のないPC",
  "To add another PC, scan the QR code it shows under Phone & devices.": "別のPCを追加するには、そのPCの「スマホとデバイス」に表示されるQRコードをスキャンしてください。",
  "Scan the QR code on your PC": "PCのQRコードをスキャンしてください",
  "On the PC, open Settings → Phone & devices and turn on remote access through the Ovis relay. The QR code there opens this app paired with that PC.": "PCで設定 → スマホとデバイスを開き、Ovisリレー経由のリモートアクセスをオンにしてください。そこに表示されるQRコードで、このアプリがそのPCとペアリングされた状態で開きます。",
  "Pair with {name}?": "{name}とペアリングしますか？",
  "This phone gets a key of its own for {name}. The PC lists it under Phone & devices, where it can be removed.": "このスマホは{name}専用のキーを受け取ります。PCの「スマホとデバイス」に表示され、そこから削除できます。",
  "Pair": "ペアリング",
  "Not now": "今はしない",
  "Connecting to {name}…": "{name}に接続中…",
  "{name} is offline": "{name}はオフラインです",
  "Its Ovis is not connected to the relay right now. Start Ovis on the PC, or check its connection, then try again.": "そのPCのOvisは今リレーに接続していません。PCでOvisを起動するか接続を確認してから、もう一度お試しください。",
  "{name} did not finish connecting": "{name}は接続を完了できませんでした",
  "The PC answered through the relay but did not complete the connection. Try again; if it keeps happening, restart Ovis on the PC.": "PCはリレー経由で応答しましたが、接続を完了できませんでした。もう一度お試しください。繰り返す場合はPCでOvisを再起動してください。",
  "The relay could not be reached": "リレーに接続できません",
  "Check this phone's connection, then try again.": "このスマホのネットワーク接続を確認してから、もう一度お試しください。",
  "Update needed": "アップデートが必要です",
  "{name} and this app speak different versions of the relay protocol. Update Ovis on the PC, then try again.": "{name}とこのアプリのリレープロトコルのバージョンが異なります。PCのOvisをアップデートしてから、もう一度お試しください。",
  "This phone was removed from {name}": "このスマホは{name}から削除されました",
  "Its pairing was revoked on the PC, so this phone's key for it is gone. To pair again, scan a new QR code on the PC.": "PC側でペアリングが取り消されたため、このスマホのキーも削除されました。再度ペアリングするには、PCで新しいQRコードをスキャンしてください。",
  "{name} has a new identity": "{name}の識別情報が変わりました",
  "The PC's relay key is not the one this phone paired with, so the saved pairing cannot be trusted. Forget it, then pair again from a new QR code on the PC.": "PCのリレーキーがこのスマホがペアリングしたものと異なるため、保存されたペアリングは信頼できません。このPCを削除してから、PCの新しいQRコードで再度ペアリングしてください。",
  "That pairing code no longer works": "このペアリングコードはもう使えません",
  "The code was wrong, used up or expired. Scan a new QR code on the PC.": "コードが間違っているか、使用済みか、期限切れです。PCで新しいQRコードをスキャンしてください。",
  "This pairing link is damaged": "このペアリングリンクは壊れています",
  "Part of the link is missing or changed. Scan the QR code on the PC again, or copy its link whole.": "リンクの一部が欠けているか変わっています。PCのQRコードをもう一度スキャンするか、リンク全体をコピーしてください。",
  "Add to Home Screen to stay paired: Safari may clear this page's storage after a week without a visit.": "ペアリングを保つにはホーム画面に追加してください。Safariは1週間アクセスのないページの保存データを消すことがあります。",
};
