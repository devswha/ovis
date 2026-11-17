import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { CornerDownLeft, Paperclip, SendHorizontal, TextCursorInput } from "lucide-react";

import "./TerminalInput.css";
import { readTerminalDraft, writeTerminalDraft, TERMINAL_LINE_LIMIT, subscribeTerminalDraft, terminalDraftSending, setTerminalDraftSending, acknowledgeTerminalDraft, terminalDraftVersion } from "../lib/terminalDraft.ts";

import { AttachmentTooLargeError, assertAttachable } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { CONTROL_CHARACTER, plainError } from "../lib/paneTerminalShared.ts";
import { useSettings } from "../lib/settings.ts";
import { MicButton, VoiceRecordingPill, useDictation } from "./VoiceInput.tsx";

export interface TerminalInputProps {
  owner: string;
  active?: boolean;
  onComposing?: (active: boolean) => void;
  connected: boolean;
  onSend: (text: string) => false | Promise<true | string>;
  onEnter: () => boolean | string;
  onInsert: (text: string) => false | Promise<true | string>;
  pasteTarget?: () => string | null;
  onPasting?: (active: boolean) => void;
  uploadFile?: (file: Blob) => Promise<string>;
  attach?: boolean;
  onFocus?: () => void;
  keyboardHeld?: boolean;
  keyControls?: ReactNode;
  ref?: Ref<TerminalInputHandle>;
}

export interface TerminalInputHandle {
  paste(): void;
  focus(): boolean;
}

const MAX_ROWS = 4;
const COMMIT_WAIT_MS = 300;

interface SendAttempt {
  timer: ReturnType<typeof setTimeout> | null;
  deadline: number;
  textSend: boolean;
}

export function TerminalInput({ owner, active = true, connected, onSend, onEnter, onInsert, pasteTarget, onPasting, uploadFile, attach = false, onComposing, onFocus, keyboardHeld = false, keyControls, ref }: TerminalInputProps) {
  const t = useT();
  const text = useSyncExternalStore(subscribeTerminalDraft, () => readTerminalDraft(owner));
  const setText = useCallback((value: string | ((previous: string) => string)) => {
    const next = typeof value === "function" ? value(readTerminalDraft(owner)) : value;
    writeTerminalDraft(owner, next);

  }, [owner]);
  const composing = useRef(false);
  const compositions = useRef(0);
  const selections = useRef(0);
  const composingCallback = useRef(onComposing);
  composingCallback.current = onComposing;
  useEffect(() => () => { composingCallback.current?.(false); }, []);

  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const sending = useSyncExternalStore(subscribeTerminalDraft, () => terminalDraftSending(owner));
  const box = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const textRef = useRef(text);
  textRef.current = text;
  const { settings } = useSettings();
  const dictation = useDictation({
    mode: "terminal",
    active,
    connected,
    polish: settings.voicePolishTerminal,
    box,
    read: () => textRef.current,
    write: (value, caret) => {
      textRef.current = value;
      setText(value);
      requestAnimationFrame(() => {
        const element = box.current;
        if (!element) return;
        element.selectionStart = element.selectionEnd = caret;
        // without focus the browser does not follow the caret: a wrapped dictation's end would stay hidden
        if (caret === element.value.length) element.scrollTop = element.scrollHeight;
      });
    },
    onNote: setNote,
  });

  // A Send tapped while the keyboard still composes the last word (Gboard composes every word,
  const attempt = useRef<SendAttempt | null>(null);
  const clearPendingSend = useCallback(() => {
    const current = attempt.current;
    if (current?.timer != null) clearTimeout(current.timer);
    attempt.current = null;
  }, []);
  useEffect(() => clearPendingSend, [clearPendingSend]);
  useEffect(() => {
    if (connected || attempt.current === null) return;
    clearPendingSend();
    setNote(t("Not sent: the terminal is disconnected."));
  }, [clearPendingSend, connected, t]);
  const sendRef = useRef<(deferred: boolean) => void>(() => {});

  const awaitCommit = useCallback((current: SendAttempt) => {
    if (current.timer !== null) clearTimeout(current.timer);
    current.timer = null;
    const left = current.deadline - Date.now();
    if (left <= 0) {
      attempt.current = null;
      setNote(t("Finish the word, then send."));
      return;
    }
    setNote(t("Finishing the word…"));
    current.timer = setTimeout(() => {
      if (attempt.current !== current) return;
      attempt.current = null;
      setNote(t("Finish the word, then send."));
    }, left);
  }, [t]);

  const send = useCallback((deferred = false) => {
    const current = attempt.current;
    if (deferred && current === null) return;
    if (!connected || terminalDraftSending(owner)) {
      if (deferred) { clearPendingSend(); setNote(connected ? null : t("Not sent: the terminal is disconnected.")); }
      return;
    }
    if (composing.current) {
      if (deferred) {
        awaitCommit(current!);
        return;
      }
      clearPendingSend();
      const tapped: SendAttempt = { timer: null, deadline: Date.now() + COMMIT_WAIT_MS, textSend: readTerminalDraft(owner).length > 0 };
      attempt.current = tapped;
      const element = box.current;
      if (element !== null && document.activeElement === element) {
        element.blur();
        element.focus({ preventScroll: true });
      }
      if (composing.current && attempt.current === tapped) awaitCommit(tapped);
      return;
    }
    clearPendingSend();
    setNote(null);
    const draft = readTerminalDraft(owner);
    if (draft.length === 0) {
      if (deferred && current!.textSend) return;
      const entered = onEnter();
      if (typeof entered === "string") setNote(entered);
      else if (!entered) setNote(t("Not sent: the terminal is disconnected."));
      return;
    }
    const sent = onSend(draft);
    if (sent === false) { setNote(t("Not sent: the terminal is disconnected.")); return; }
    dictation.forget();
    setTerminalDraftSending(owner, true);
    void sent.then((result) => {
      if (result === true) {
        acknowledgeTerminalDraft(owner);
      } else setNote(result);
    }).catch(() => setNote(t("Not confirmed. Check the terminal before sending again."))).finally(() => { setTerminalDraftSending(owner, false); });
  }, [awaitCommit, clearPendingSend, connected, dictation.forget, onEnter, onSend, owner, t]);
  sendRef.current = send;

  const insert = useCallback(() => {
    if (!connected || terminalDraftSending(owner)) return;
    if (composing.current) { setNote(t("Finish the word, then insert.")); return; }
    clearPendingSend();
    setNote(null);
    const draft = readTerminalDraft(owner);
    if (draft.length === 0) return;
    if (/[\r\n]/.test(draft)) { setNote(t("Insert takes one line. Send several lines, or insert them one at a time.")); return; }
    const sent = onInsert(draft);
    if (sent === false) { setNote(t("Not inserted: the terminal is disconnected.")); return; }
    dictation.forget();
    setTerminalDraftSending(owner, true);
    void sent.then((result) => {
      if (result === true) acknowledgeTerminalDraft(owner);
      else setNote(result);
    }).catch(() => setNote(t("Not confirmed: the terminal did not confirm the text. Check it before inserting again."))).finally(() => { setTerminalDraftSending(owner, false); });
  }, [clearPendingSend, connected, dictation.forget, onInsert, owner, t]);

  const pasting = useRef(false);
  const beginPaste = useCallback((element: HTMLTextAreaElement, waiting: string, native = false) => {
    const target = pasteTarget?.() ?? null;
    if (target === null) { setNote(t("Not pasted: the terminal is not ready.")); return null; }
    const version = terminalDraftVersion(owner);
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const composed = compositions.current;
    const selected = selections.current;
    const atPaste = (from: number, to: number): boolean => (from === start && to === end) || (native && from === end && to === end);
    // a caret moved in the focused line, by touch or by script, while the paste waits; each move
    let seen = [start, end];
    let first = true;
    const moved = (): void => {
      if (document.activeElement !== element) return;
      const from = element.selectionStart;
      const to = element.selectionEnd;
      if (from === seen[0] && to === seen[1]) return;
      const own = first && atPaste(from, to);
      first = false;
      seen = [from, to];
      if (!own) selections.current += 1;
    };
    document.addEventListener("selectionchange", moved);
    pasting.current = true;
    onPasting?.(true);
    setNote(null);
    setPending(waiting);
    const shown = (): boolean => mounted.current && box.current === element;
    const stale = (): boolean => composing.current || compositions.current !== composed || selections.current !== selected
      || !atPaste(element.selectionStart, element.selectionEnd)
      || (pasteTarget?.() ?? null) !== target || terminalDraftVersion(owner) !== version;
    const changed = t("Not pasted: the line or the terminal changed meanwhile. Paste again.");
    return {
      shown,
      dropped(): boolean {
        if (!shown()) return true;
        if (!stale()) return false;
        setNote(changed);
        return true;
      },
      fail(note: string): void { if (shown()) setNote(note); },
      place(clip: string, whole = false): void {
        if (!shown()) return;
        if (stale()) { setNote(changed); return; }
        const text = clip.replace(/\r\n?/g, "\n");
        const current = readTerminalDraft(owner);
        const next = current.slice(0, start) + text + current.slice(end);
        if (whole && next.length > TERMINAL_LINE_LIMIT) { setNote(t("Not pasted: the line has no room for the file's path. Shorten it, then paste again.")); return; }
        writeTerminalDraft(owner, next);
        const written = readTerminalDraft(owner);
        const cut = next.length - written.length;
        setNote(cut > 0 ? t("Pasted up to the line's limit: {n} characters were left out.", { n: cut }) : null);
        const caret = Math.min(start + text.length, written.length);
        const pasted = terminalDraftVersion(owner);
        requestAnimationFrame(() => {
          if (box.current !== element || (pasteTarget?.() ?? null) !== target || terminalDraftVersion(owner) !== pasted) return;
          element.focus({ preventScroll: true });
          element.setSelectionRange(caret, caret);
        });
      },
      finish(): void {
        document.removeEventListener("selectionchange", moved);
        pasting.current = false;
        if (!mounted.current) return;
        onPasting?.(false);
        setPending(null);
      },
    };
  }, [onPasting, owner, pasteTarget, t]);

  const uploadPaths = useCallback(async (files: Blob[]): Promise<string> => {
    const paths: string[] = [];
    for (const file of files) paths.push(await uploadFile!(file));
    if (paths.some((path) => CONTROL_CHARACTER.test(path))) throw new Error(t("Not pasted: the file's path holds a line break, which the terminal would take as Enter."));
    return paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ") + " ";
  }, [t, uploadFile]);
  const uploadFailed = useCallback((error: unknown): string => error instanceof AttachmentTooLargeError ? error.message : plainError(error), []);

  const pasteFiles = (element: HTMLTextAreaElement, files: File[], native: boolean): void => {
    if (pasting.current) { setNote(t("Wait for the paste on its way, then paste again.")); return; }
    if (composing.current) { setNote(t("Finish the word, then paste.")); return; }
    try {
      for (const file of files) assertAttachable(file);
    } catch (error) {
      setNote(uploadFailed(error));
      return;
    }
    const waiting = beginPaste(element, t("Uploading file…"), native);
    if (waiting === null) return;
    uploadPaths(files).then((paths) => waiting.place(paths, true), (error: unknown) => waiting.fail(uploadFailed(error))).finally(waiting.finish);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (event.clipboardData.getData("text/plain")) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0 || uploadFile === undefined) return;
    event.preventDefault();
    pasteFiles(event.currentTarget, files, true);
  };
  const picker = useRef<HTMLInputElement>(null);
  const pickedFor = useRef<{ target: string; version: number } | null>(null);
  const openPicker = (): void => {
    const target = pasteTarget?.() ?? null;
    if (target === null) { setNote(t("Not pasted: the terminal is not ready.")); return; }
    pickedFor.current = { target, version: terminalDraftVersion(owner) };
    picker.current?.click();
  };
  const onPicked = (files: File[]): void => {
    const opened = pickedFor.current;
    pickedFor.current = null;
    const element = box.current;
    if (opened === null || files.length === 0 || element === null) return;
    if ((pasteTarget?.() ?? null) !== opened.target || terminalDraftVersion(owner) !== opened.version) {
      setNote(t("Not pasted: the line or the terminal changed meanwhile. Paste again."));
      return;
    }
    pasteFiles(element, files, false);
  };

  const paste = useCallback(() => {
    const element = box.current;
    if (pasting.current || element === null) return;
    if (composing.current) { setNote(t("Finish the word, then paste.")); return; }
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    const readsFiles = typeof clipboard?.read === "function" && uploadFile !== undefined;
    if (!readsFiles && typeof clipboard?.readText !== "function") { setNote(t("Paste is not available here. Use the keyboard's own paste in the input line.")); return; }
    const waiting = beginPaste(element, t("Reading the clipboard…"));
    if (waiting === null) return;
    const read: Promise<{ text: string } | { image: Blob }> = readsFiles
      ? clipboard!.read().then(async (items) => {
        const texts = items.filter((item) => item.types.includes("text/plain"));
        const text = (await Promise.all(texts.map(async (item) => (await item.getType("text/plain")).text()))).join("");
        if (text.length > 0) return { text };
        for (const item of items) {
          const type = item.types.find((kind) => kind.startsWith("image/"));
          if (type !== undefined) return { image: await item.getType(type) };
        }
        return { text };
      })
      : clipboard!.readText().then((text) => ({ text }));
    read.then(async (clip) => {
      if (!waiting.shown()) return;
      if ("image" in clip) {
        if (waiting.dropped()) return;
        try {
          assertAttachable(clip.image);
        } catch (error) {
          waiting.fail(uploadFailed(error));
          return;
        }
        setPending(t("Uploading file…"));
        await uploadPaths([clip.image]).then((paths) => waiting.place(paths, true), (error: unknown) => waiting.fail(uploadFailed(error)));
        return;
      }
      if (clip.text.length === 0) {
        waiting.fail(readsFiles ? t("Nothing to paste: the clipboard is empty.") : t("No text on the clipboard. To paste an image, press and hold the input line, then choose Paste."));
        return;
      }
      waiting.place(clip.text);
    }, () => {
      waiting.fail(t("The clipboard could not be read. Use the keyboard's own paste in the input line."));
    }).finally(waiting.finish);
  }, [beginPaste, uploadFailed, uploadFile, uploadPaths, t]);
  const focus = useCallback((): boolean => {
    const element = box.current;
    if (element === null) return false;
    element.focus({ preventScroll: true });
    return true;
  }, []);
  useImperativeHandle(ref, () => ({ paste, focus }), [paste, focus]);
  const pastingCallback = useRef(onPasting);
  pastingCallback.current = onPasting;
  useEffect(() => () => { if (pasting.current) pastingCallback.current?.(false); }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter breaks the line; an IME keeps its Enter, including the committing
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  const [wrappedRows, setWrappedRows] = useState(1);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight);
    if (!(line > 0)) return;
    const shown = element.rows;
    element.rows = 1;
    const content = element.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    element.rows = shown;
    setWrappedRows(Math.max(1, Math.round(content / line)));
  }, [text]);
  const rows = Math.min(MAX_ROWS, Math.max(wrappedRows, text.split("\n").length));
  const fieldId = useId();
  return (
    <div className={`terminal-input${dictation.shown ? " has-voice" : ""}${keyControls ? " has-key-controls" : ""}`}>
      <label className="terminal-input-label" htmlFor={fieldId}>{t("Input line")}</label>
      <textarea
        ref={box}
        id={fieldId}
        className="terminal-input-text"
        inputMode={keyboardHeld ? "none" : undefined}
        rows={rows}
        value={text}
        maxLength={TERMINAL_LINE_LIMIT}
        onCompositionStart={() => { composing.current = true; compositions.current += 1; onComposing?.(true); }}
        onCompositionEnd={() => {
          composing.current = false;
          compositions.current += 1;
          onComposing?.(false);
          const current = attempt.current;
          if (current === null) return;
          if (current.timer !== null) clearTimeout(current.timer);
          current.timer = null;
          // WebKit updates the value with an input event after compositionend: send the committed word
          setTimeout(() => sendRef.current(true));
        }}
        placeholder={t("Type for the terminal…")}
        aria-label={t("Terminal input line")}
        enterKeyHint="send"
        // the keyboard's word strip too: Chrome on Android hands the keyboard NO_SUGGESTIONS only
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          setNote(null);
          if (event.target.value.length === 0) clearPendingSend();
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={onFocus}
      />
      {dictation.shown && <MicButton dictation={dictation} className="terminal-input-mic" />}
      <span className="terminal-input-actions">
        {keyControls}
        {attach && uploadFile !== undefined && <>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const picked = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              onPicked(picked);
            }}
          />
          <button
            type="button"
            className="terminal-input-action terminal-input-attach"
            aria-label={t("Attach files")}
            title={t("Attach files")}
            disabled={!connected || sending || pending !== null}
            onPointerDown={(event) => event.preventDefault()}
            onClick={openPicker}
          >
            <span className="terminal-input-caption" aria-hidden="true">{t("Attach")}</span>
            <span className="terminal-input-face"><Paperclip aria-hidden="true" /></span>
          </button>
        </>}
        <button
          type="button"
          className="terminal-input-action terminal-input-insert"
          aria-label={t("Insert text without Enter")}
          title={t("Insert text without Enter")}
          disabled={!connected || sending || text.length === 0}
          onPointerDown={(event) => event.preventDefault()}
          onClick={insert}
        >
          <span className="terminal-input-caption" aria-hidden="true">{t("Insert text")}</span>
          <span className="terminal-input-face"><TextCursorInput aria-hidden="true" /></span>
        </button>
        <button
          type="button"
          className="terminal-input-action terminal-input-send"
          aria-label={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
          title={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
          disabled={!connected || sending}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => send()}
        >
          <span className="terminal-input-caption" aria-hidden="true">{t(text.length === 0 ? "Enter" : "Send")}</span>
          <span className="terminal-input-face">{text.length === 0 ? <CornerDownLeft aria-hidden="true" /> : <SendHorizontal aria-hidden="true" />}</span>
        </button>
      </span>
      {pending !== null && note === null && <p className="terminal-input-note is-pending" role="status">{pending}</p>}
      {note !== null && <p className="terminal-input-note" role="alert">{note}</p>}
      {dictation.shown && <VoiceRecordingPill dictation={dictation} align="end" />}
    </div>
  );
}
