import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bot, Globe, MousePointerClick, RotateCw, X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { cancelBrowserPick, canPickBrowserElement, goBrowserTab, hideBrowserTab, holdBrowserTab, navigateBrowserTab, openBrowserTab, pickBrowserElement, showBrowserTab, typedAddress, type DesktopBrowserTab, type PickedBrowserElement } from "../lib/desktopBrowser.ts";
import "./FileViewer.css";
import "./BrowserPanel.css";

export interface BrowserPanelProps {
  /** the tab shown, or null for a new tab of the person's own that has no address yet */
  tab: DesktopBrowserTab | null;
  onOpened: (id: number) => void;
  onClose: () => void;
  /** whether a chat composer beside the panel can receive a picked element */
  canPick?: boolean;
  /** called with the picked element; returns false when the composer has no room for it */
  onPicked?: (picked: PickedBrowserElement) => boolean;
  panelStart?: ReactNode;
  /** a dialog is over the panel: the tab, drawn by the app above the page, steps aside for it */
  covered?: boolean;
}

/**
 * A tab of the desktop app's built-in browser in the file panel's place. The app draws the page
 * itself over this panel's body (app/electron/src/browserTabs.ts), which reports where it is. An
 * agent's tab is only watched until the person takes control of it; the agent waits meanwhile.
 */
export function BrowserPanel({ tab, onOpened, onClose, canPick = false, onPicked, panelStart, covered = false }: BrowserPanelProps) {
  const t = useT();
  const body = useRef<HTMLDivElement>(null);
  const [refused, setRefused] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickFull, setPickFull] = useState(false);
  const id = tab?.id ?? null;
  const steered = tab !== null && (tab.profile === "mine" || tab.held);
  const pickSupported = canPick && onPicked !== undefined && canPickBrowserElement();

  useLayoutEffect(() => {
    const place = body.current;
    if (id === null || covered || place === null) {
      hideBrowserTab();
      return;
    }
    const show = () => {
      const { x, y, width, height } = place.getBoundingClientRect();
      showBrowserTab(id, { x, y, width, height });
    };
    show();
    const resized = new ResizeObserver(show);
    resized.observe(place);
    window.addEventListener("resize", show);
    return () => {
      resized.disconnect();
      window.removeEventListener("resize", show);
      hideBrowserTab();
    };
  }, [id, covered]);

  // which address form an answer from main belongs to: a new tab's form left (closed, or another tab shown) drops its answer
  const form = useRef(0);
  useEffect(() => { form.current += 1; }, [tab?.id]);
  useEffect(() => () => { form.current = -1; }, []);

  // which pick request an answer from main belongs to: leaving the tab, covering the panel or cancelling drops it
  const pickSeq = useRef(0);
  const onPickedRef = useRef(onPicked);
  onPickedRef.current = onPicked;

  const stopPick = (tabId: number | null) => {
    pickSeq.current += 1;
    setPicking(false);
    if (tabId !== null) cancelBrowserPick(tabId);
  };

  useEffect(() => {
    setPickFull(false);
    return () => {
      if (id !== null) cancelBrowserPick(id);
      pickSeq.current += 1;
      setPicking(false);
    };
  }, [id]);

  useEffect(() => {
    if (picking && (!steered || covered || !pickSupported)) stopPick(id);
  }, [picking, steered, covered, pickSupported, id]);

  useEffect(() => {
    if (!picking || id === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      stopPick(id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [picking, id]);

  const togglePick = () => {
    if (id === null || !steered || covered || !pickSupported) return;
    if (picking) {
      stopPick(id);
      return;
    }
    setPickFull(false);
    setPicking(true);
    const seq = ++pickSeq.current;
    void pickBrowserElement(id).then((picked) => {
      if (pickSeq.current !== seq) return;
      setPicking(false);
      if (picked === null) return;
      const attached = onPickedRef.current?.(picked) ?? false;
      if (!attached) setPickFull(true);
    });
  };

  const go = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // an agent's tab is only watched until taken: Enter in its read-only address does nothing
    if (tab !== null && !steered) return;
    const address = typedAddress(new FormData(event.currentTarget).get("address")?.toString() ?? "");
    if (address === null) {
      setRefused(true);
      return;
    }
    const asked = form.current;
    const opened = tab === null ? openBrowserTab(address).then((opened) => { if (opened !== null && form.current === asked) onOpened(opened); return opened !== null; }) : navigateBrowserTab(tab.id, address);
    void opened.then((done) => { if (form.current === asked) setRefused(!done); });
  };

  const title = tab === null ? t("New tab") : tab.title || tab.address;
  return (
    <div className="file-panel web-panel browser-panel">
      {panelStart}
      <section className="file-viewer file-viewer-docked" aria-label={title}>
        <header className="file-viewer-header file-viewer-header-docked">
          {tab?.profile === "agent" ? <Bot aria-hidden="true" className="file-viewer-glyph" /> : <Globe aria-hidden="true" className="file-viewer-glyph" />}
          <div className="file-viewer-actions">
            <button type="button" className="icon-button file-viewer-action" aria-label={t("Back")} title={t("Back")} disabled={!steered || !tab.canGoBack} onClick={() => tab && goBrowserTab(tab.id, "back")}><ArrowLeft aria-hidden="true" /></button>
            <button type="button" className="icon-button file-viewer-action" aria-label={t("Forward")} title={t("Forward")} disabled={!steered || !tab.canGoForward} onClick={() => tab && goBrowserTab(tab.id, "forward")}><ArrowRight aria-hidden="true" /></button>
            <button type="button" className="icon-button file-viewer-action" aria-label={t("Reload page")} title={t("Reload page")} disabled={!steered} onClick={() => tab && goBrowserTab(tab.id, "reload")}><RotateCw aria-hidden="true" /></button>
          </div>
          <form className="browser-panel-address" onSubmit={go}>
            <input key={`${id}:${tab?.address ?? ""}`} name="address" className="input" defaultValue={tab?.address ?? ""} readOnly={tab !== null && !steered} aria-label={t("Address")} placeholder={t("Type an address")}
              aria-invalid={refused || undefined} autoFocus={tab === null} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="go" onChange={() => setRefused(false)} />
          </form>
          {pickSupported && (
            <button
              type="button"
              className={`icon-button file-viewer-action browser-panel-pick${picking ? " is-picking" : ""}`}
              aria-label={t("Pick element")}
              title={t("Pick an element to attach to the chat")}
              aria-pressed={picking}
              disabled={!steered || covered}
              onClick={togglePick}
            >
              <MousePointerClick aria-hidden="true" />
            </button>
          )}
          {/* back to the panel: the tab stays open (the sidebar's row and the card close it) */}
          <button type="button" className="icon-button file-viewer-action file-viewer-close" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {tab?.profile === "agent" && <div className={`browser-panel-holder${tab.held ? " is-held" : ""}`}>
          <span>{tab.held ? t("You have control · the agent waits") : t("An agent is using this tab")}</span>
          <button type="button" className={`btn btn-sm${tab.held ? " btn-primary" : ""}`} onClick={() => holdBrowserTab(tab.id, !tab.held)}>{tab.held ? t("Stop") : t("Take control")}</button>
        </div>}
        {picking && <div className="browser-panel-holder is-held" role="status">
          <span>{t("Click an element on the page to attach it to the chat.")}</span>
          <button type="button" className="btn btn-sm" onClick={() => stopPick(id)}>{t("Cancel")}</button>
        </div>}
        {refused && <p className="browser-panel-refused" role="alert">{t("This address can't be opened in the built-in browser.")}</p>}
        {pickFull && <p className="browser-panel-refused" role="alert">{t("The message box is full.")}</p>}
        <div ref={body} className="file-viewer-body browser-panel-body">
          {tab === null && <p className="browser-panel-hint">{t("Type an address to open it in a tab of your own. Its cookies stay apart from the agents' tabs.")}</p>}
        </div>
      </section>
    </div>
  );
}
