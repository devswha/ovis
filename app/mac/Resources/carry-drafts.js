// Ovis for Mac writes this into the page at a new address (another port is another origin, with
// storage of its own) before the page's code starts: the unsent drafts read from the page the window
// left (WebPage.swift). Nothing here sends anything; a draft waits in the page for Send or Discard.
//
// The app's storage is its own, so what the new origin holds is from the app's earlier visit there,
// older than the page just left: a carried key replaces it, and a chat send left on its way there is
// over (the new page has none of its own yet). Unless `shared`, a window the page opened still open
// there: then that window's drafts and sends are live, and a carried key only fills a gap.
//
// `ovis-mac:carried` records the carry's token and the keys that landed. A later run of the same carry
// (a reload before the page finished, or a window it opened meanwhile) writes only the keys that did not
// land, and only where the page has not written one itself, so it never puts carried text back over what
// was typed since. The app reads the landed keys when the page has loaded and keeps the rest.
function ovisCarryDrafts(storage, carried, shared, token) {
  const MARK = "ovis-mac:carried";
  let mark = null;
  try {
    mark = JSON.parse(storage.getItem(MARK) ?? "null");
  } catch {
    // storage that cannot be read takes nothing; a mark that is not JSON is not this carry's
  }
  const again = mark !== null && typeof mark === "object" && mark.token === token && Array.isArray(mark.done);
  const landed = new Set(again ? mark.done : []);
  if (!again) {
    // the mark first: a draft written without one would be written again over what is typed since
    try {
      storage.setItem(MARK, JSON.stringify({ token, done: [] }));
    } catch {
      return;
    }
  }
  if (!again && !shared) {
    try {
      const leases = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith("ovis:composer-sending:") && !Object.hasOwn(carried, key)) leases.push(key);
      }
      for (const key of leases) storage.removeItem(key);
    } catch {
      // a lease left behind runs out by itself
    }
  }
  for (const [key, value] of Object.entries(carried)) {
    if (landed.has(key)) continue;
    try {
      if ((shared || again) && storage.getItem(key) !== null) {
        landed.add(key);
        continue;
      }
      storage.setItem(key, value);
      landed.add(key);
      storage.setItem(MARK, JSON.stringify({ token, done: [...landed] }));
    } catch {
      // one key that does not fit (a full store) does not stop the rest; it stays in the app to retry
    }
  }
  try {
    storage.setItem(MARK, JSON.stringify({ token, done: [...landed] }));
  } catch {
    // the per-key marks above already say what landed
  }
}
