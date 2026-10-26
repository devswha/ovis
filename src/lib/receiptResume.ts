/** Presentation-only correlation; never a credential, lease, or permission to send input.
 * Its own key survives a reload without changing any existing draft/storage shape. */
const KEY = "ovis:pi-receipt-resume";
let memory: string | undefined;
export function receiptResumeId(): string {
  if (memory) return memory;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && /^[a-f0-9-]{36}$/.test(saved)) return memory = saved;
  } catch { /* memory-only when browser storage is unavailable */ }
  memory = crypto.randomUUID();
  try { localStorage.setItem(KEY, memory); } catch { /* reconnect within this page still works */ }
  return memory;
}
