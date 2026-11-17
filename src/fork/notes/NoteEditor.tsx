import { useEffect, useMemo, useRef } from "react";
import { Extension, InputRule } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";

/**
 * `- [ ] ` as Markdown writes it: `- ` has made a bullet by the time `[ ] ` is typed, so in a bullet the box makes it
 * a task (TaskItem's own rule only starts one from a plain line).
 */
const BulletTask = Extension.create({
  name: "bulletTask",
  addInputRules() {
    return [new InputRule({
      find: /^\[([ xX])?\]\s$/,
      handler: ({ state, range, match, chain }) => {
        const { $from } = state.selection;
        if ($from.depth < 3 || $from.node(-1).type.name !== "listItem" || $from.node(-2).type.name !== "bulletList") return null;
        // this line alone leaves its bullets for a task list of its own (a neighbouring one takes it in)
        chain().deleteRange(range).liftListItem("listItem").toggleTaskList().updateAttributes("taskItem", { checked: /x/i.test(match[1] ?? "") }).run();
      },
    })];
  },
});

const EXTENSIONS = [StarterKit.configure({ link: { openOnClick: false } }), TaskList, TaskItem.configure({ nested: true }), BulletTask, Markdown];

/**
 * A note's text, formatted as it is typed (TipTap): `# ` makes a heading, `**` bold, `- ` a list, `- [ ]` a task,
 * the file staying the Markdown it was. Loaded with the note only (NotesInbox.tsx), so the app's own bundle
 * carries none of it. `onText` gets a reader of the Markdown, so a save reads it once, when it is made.
 */
export default function NoteEditor({ text, editable, label, onText }: { text: string; editable: boolean; label: string; onText(read: () => string): void }) {
  const changed = useRef(onText);
  changed.current = onText;
  // the same options object on every render: TipTap compares them by identity and re-applies changed ones, which
  // can move the cursor while a note is typed in
  const editorProps = useMemo(() => ({ attributes: { class: "markdown fork-note-text", "aria-label": label, "aria-multiline": "true", role: "textbox" } }), [label]);
  const editor = useEditor({
    extensions: EXTENSIONS,
    content: text,
    contentType: "markdown",
    editable,
    shouldRerenderOnTransaction: false,
    editorProps,
    onUpdate: ({ editor: current }) => changed.current(() => current.getMarkdown()),
  });
  useEffect(() => { editor?.setEditable(editable); }, [editor, editable]);
  return <EditorContent editor={editor} className="fork-note-editor" />;
}
