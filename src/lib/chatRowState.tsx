import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ComponentProps, type FocusEvent } from "react";

/** State belongs to a logical row, not to a virtualizer container. */
export interface ChatRowMemory {
  readonly toggles: Map<string, boolean | null>;
  readonly outputs: Map<string, string>;
  /** an agent turn's part index → the name of the run of work it was in when last drawn (runNames) */
  readonly runs: Map<number, string>;
  /** the row whose head holds the keyboard's focus (useRowFocus) */
  focused?: string;
}

export const ChatRowMemoryContext = createContext<ChatRowMemory | null>(null);

export function useChatRowToggle(key: string, initial: boolean | null) {
  const memory = useContext(ChatRowMemoryContext);
  const [value, setValue] = useState(() => memory?.toggles.has(key) ? memory.toggles.get(key) ?? null : initial);
  const update = useCallback((next: boolean | null) => {
    memory?.toggles.set(key, next);
    setValue(next);
  }, [key, memory]);
  return [value, update] as const;
}

/**
 * Keeps the keyboard's focus on a row when the element drawing it is replaced: a todo update the
 * next one folds into a Plan row (#1601). The head records that it holds the focus; a head drawn
 * again for that row, or for a row taking its place (`from`), takes the focus back if it fell to
 * the page because the old element left. Focus the reader moved elsewhere is never taken.
 */
export function useRowFocus<T extends HTMLElement>(key: string, from: readonly string[] = []) {
  const memory = useContext(ChatRowMemoryContext);
  const ref = useRef<T>(null);
  // only when drawn: a head already on the page keeps or loses the focus by the reader's hand
  useLayoutEffect(() => {
    const focused = memory?.focused;
    const head = ref.current;
    if (head === null || focused === undefined || (focused !== key && !from.includes(focused))) return;
    const active = document.activeElement;
    if (active === null || active === document.body) head.focus({ preventScroll: true });
  }, []);
  const onFocus = useCallback(() => { if (memory) memory.focused = key; }, [memory, key]);
  // a head that leaves the page takes no blur from it: the record stays for the head that replaces it
  const onBlur = useCallback((event: FocusEvent<T>) => {
    if (memory && memory.focused === key && event.currentTarget.isConnected) memory.focused = undefined;
  }, [memory, key]);
  return { ref, onFocus, onBlur };
}

/** Native disclosures retain their open state when their row leaves the DOM. */
export function ChatDetails({ memoryKey, onToggle, ...props }: ComponentProps<"details"> & { memoryKey: string }) {
  const [open, setOpen] = useChatRowToggle(memoryKey, false);
  return <details {...props} open={open === true} onToggle={(event) => {
    setOpen(event.currentTarget.open);
    onToggle?.(event);
  }} />;
}
