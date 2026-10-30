/**
 * Korean for the keys only the hosted relay shell uses: components/RelayShell.tsx.
 * Register and fixed terms follow ../i18n.ko.ts; a key another feature also uses goes there.
 */
export const RELAY_KO: Record<string, string> = {
  "this PC": "이 PC",
  "Your PCs": "내 PC",
  "Unnamed PC": "이름 없는 PC",
  "To add another PC, scan the QR code it shows under Phone & devices.": "다른 PC를 추가하려면 그 PC의 폰 및 기기 화면에 나오는 QR 코드를 스캔하세요.",
  "Scan the QR code on your PC": "PC에서 QR 코드를 스캔하세요",
  "On the PC, open Settings → Phone & devices and turn on remote access through the Ovis relay. The QR code there opens this app paired with that PC.": "PC에서 설정 → 폰 및 기기를 열고 Ovis 릴레이를 통한 원격 접속을 켜세요. 거기에 나오는 QR 코드가 이 앱을 그 PC와 페어링된 상태로 엽니다.",
  "Pair with {name}?": "{name}와(과) 페어링할까요?",
  "This phone gets a key of its own for {name}. The PC lists it under Phone & devices, where it can be removed.": "이 폰은 {name} 전용 키를 받습니다. PC의 폰 및 기기 목록에 나타나며 거기서 삭제할 수 있습니다.",
  "Pair": "페어링",
  "Not now": "나중에",
  "Connecting to {name}…": "{name}에 연결하는 중…",
  "{name} is offline": "{name}이(가) 오프라인입니다",
  "Its Ovis is not connected to the relay right now. Start Ovis on the PC, or check its connection, then try again.": "그 PC의 Ovis가 지금 릴레이에 연결되어 있지 않습니다. PC에서 Ovis를 시작하거나 연결 상태를 확인한 뒤 다시 시도하세요.",
  "The relay could not be reached": "릴레이에 연결할 수 없습니다",
  "Check this phone's connection, then try again.": "이 폰의 네트워크 연결을 확인한 뒤 다시 시도하세요.",
  "Update needed": "업데이트가 필요합니다",
  "{name} and this app speak different versions of the relay protocol. Update Ovis on the PC, then try again.": "{name}와(과) 이 앱의 릴레이 프로토콜 버전이 다릅니다. PC의 Ovis를 업데이트한 뒤 다시 시도하세요.",
  "This phone was removed from {name}": "이 폰은 {name}에서 제거되었습니다",
  "Its pairing was revoked on the PC, so this phone's key for it is gone. To pair again, scan a new QR code on the PC.": "PC에서 페어링이 폐기되어 이 폰의 해당 키도 삭제되었습니다. 다시 페어링하려면 PC에서 새 QR 코드를 스캔하세요.",
  "{name} has a new identity": "{name}의 신원이 바뀌었습니다",
  "The PC's relay key is not the one this phone paired with, so the saved pairing cannot be trusted. Forget it, then pair again from a new QR code on the PC.": "PC의 릴레이 키가 이 폰이 페어링했던 키와 다르므로 저장된 페어링을 신뢰할 수 없습니다. 이 PC를 잊은 뒤 PC의 새 QR 코드로 다시 페어링하세요.",
  "That pairing code no longer works": "그 페어링 코드는 더 이상 쓸 수 없습니다",
  "The code was wrong, used up or expired. Scan a new QR code on the PC.": "코드가 틀렸거나 이미 쓰였거나 만료되었습니다. PC에서 새 QR 코드를 스캔하세요.",
  "This pairing link is damaged": "이 페어링 링크는 손상되었습니다",
  "Part of the link is missing or changed. Scan the QR code on the PC again, or copy its link whole.": "링크의 일부가 빠졌거나 바뀌었습니다. PC에서 QR 코드를 다시 스캔하거나 링크 전체를 복사하세요.",
  "Add to Home Screen to stay paired: Safari may clear this page's storage after a week without a visit.": "페어링을 유지하려면 홈 화면에 추가하세요. Safari는 일주일 동안 방문하지 않은 페이지의 저장 데이터를 지울 수 있습니다.",
};
