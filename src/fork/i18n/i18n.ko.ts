/**
 * Keys only this fork's Settings rows use: components/ForkSettingsRows.tsx.
 * Register and fixed terms follow ../i18n.ko.ts; a key another feature also uses goes there.
 */
import { FORK_I18N } from "./i18n.ts";
import { FORK_FEATURE_I18N } from "./featureI18n.ts";
import { GITHUB_I18N } from "../github/githubI18n.ts";
import { NOTES_I18N } from "../notes/notesI18n.ts";

export const FORK_KO: Record<string, string> = {
  ...FORK_FEATURE_I18N.ko,
  ...GITHUB_I18N.ko,
  ...NOTES_I18N.ko,
  ...FORK_I18N.ko,
  "Follow Omarchy": "Omarchy 따라가기",
  "This device has not sent its Omarchy theme. Its theme-set hook (scripts/omarchy-theme-hook.sh) sends it whenever the theme changes.": "이 기기는 아직 Omarchy 테마를 보내지 않았습니다. theme-set 훅(scripts/omarchy-theme-hook.sh)이 테마가 바뀔 때마다 보냅니다.",
  "Draws this device in its Omarchy theme, {name}, and changes with it. Only on this device: the themes above stay for the others.": "이 기기를 Omarchy 테마 {name}(으)로 그리고 테마가 바뀌면 따라 바꿉니다. 이 기기에서만: 다른 기기는 위의 테마를 유지합니다.",
  "Voice": "음성",
  "American": "미국식",
  "British": "영국식",
  "The speaker button under a reply reads it on this device. Kokoro speaks on the server, free and offline; the first time it takes a few minutes to set up.": "답변 아래의 스피커 버튼을 누르면 이 기기에서 읽어 줍니다. 음성은 서버의 Kokoro가 무료로, 오프라인에서 만듭니다. 처음 한 번은 준비하는 데 몇 분이 걸립니다.",
  "Same as Pi": "Pi와 같음",
  "The voice of a live call with a Pi pane, from the next call on. Same as Pi uses the voice set in Pi's /openai-settings.": "Pi 창과의 실시간 통화에서 쓰는 음성으로, 다음 통화부터 적용됩니다. \"Pi와 같음\"은 Pi의 /openai-settings에서 정한 음성을 씁니다.",
  "Open work while the agent runs": "에이전트 작업 중 작업 펼치기",
  "Off, a running turn shows only its Working… row until tapped": "끄면 실행 중인 턴은 탭할 때까지 \"작업 중…\" 줄만 표시합니다",
};
