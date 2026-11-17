/** Notes (NotesInbox.tsx, Places.tsx): each key in Korean, Japanese and Chinese. */
const STRINGS: Record<string, [ko: string, ja: string, zh: string]> = {
  "Notes": ["노트", "ノート", "笔记"],
  "New note": ["새 노트", "新しいノート", "新建笔记"],
  "Search notes": ["노트 검색", "ノートを検索", "搜索笔记"],
  "Agent notes": ["에이전트 노트", "エージェントのノート", "代理笔记"],
  "Reading notes…": ["노트를 읽는 중…", "ノートを読み込んでいます…", "正在读取笔记…"],
  "Could not read the notes": ["노트를 읽을 수 없습니다", "ノートを読み込めません", "无法读取笔记"],
  "Could not read this note": ["이 노트를 읽을 수 없습니다", "このノートを読み込めません", "无法读取此笔记"],
  "Could not rename this note": ["이 노트의 이름을 바꿀 수 없습니다", "このノートの名前を変更できません", "无法重命名此笔记"],
  "This note is gone": ["이 노트는 사라졌습니다", "このノートはもうありません", "此笔记已不存在"],
  "No notes yet": ["아직 노트가 없습니다", "まだノートはありません", "还没有笔记"],
  "No notes match": ["일치하는 노트가 없습니다", "一致するノートはありません", "没有匹配的笔记"],
  "Choose a note, or make a new one with +.": ["노트를 고르거나 +로 새로 만드세요.", "ノートを選ぶか、+ で新しく作成します。", "选择一个笔记，或用 + 新建一个。"],
  "Note name": ["노트 이름", "ノート名", "笔记名称"],
  "Another note has that name": ["같은 이름의 노트가 이미 있습니다", "同じ名前のノートがすでにあります", "已有同名笔记"],
  "Not saved: check the connection": ["저장하지 못했습니다. 연결을 확인하세요", "保存できませんでした。接続を確認してください", "未保存：请检查连接"],
  "Delete note": ["노트 삭제", "ノートを削除", "删除笔记"],
  "Delete {name}?": ["{name}을(를) 삭제할까요?", "{name} を削除しますか？", "删除 {name}？"],
  "Removes its file from the notes folder.": ["노트 폴더에서 파일을 지웁니다.", "ノートフォルダーからファイルを削除します。", "从笔记文件夹中删除其文件。"],
};

const pick = (index: 0 | 1 | 2): Record<string, string> => Object.fromEntries(Object.entries(STRINGS).map(([key, values]) => [key, values[index]]));
export const NOTES_I18N = { ko: pick(0), ja: pick(1), zh: pick(2) };
