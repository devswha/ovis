import { useLayoutEffect, useRef } from "react";
import { Folder, FolderGit2, GitBranch } from "lucide-react";
import { composerStrip } from "../lib/composerStrip.ts";
import { useT } from "../lib/i18n.ts";

/** Upstream's desktop context strip, when branch-in-header has not replaced it. */
export function ComposerContext({ cwd, branch, repo, mobile, facesLoaded }: { cwd: string | null; branch: string | null; repo: string | null; mobile: boolean; facesLoaded: number }) {
  const t = useT();
  const strip = mobile ? null : composerStrip({ cwd, branch, repo });
  const worktree = repo !== null;
  const stripRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = stripRef.current;
    if (!element) return;
    const fit = (): void => {
      const folder = element.querySelector<HTMLElement>(".composer-strip-folder");
      if (!folder) return;
      const branch = element.querySelector<HTMLElement>(".composer-strip-branch");
      element.dataset.fullPath = "";
      element.dataset.measuring = "";
      const styles = getComputedStyle(element);
      const available = element.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
      const needed = folder.getBoundingClientRect().width + (branch ? branch.getBoundingClientRect().width + parseFloat(styles.columnGap) : 0);
      element.toggleAttribute("data-full-path", strip?.path != null && needed <= available);
      delete element.dataset.measuring;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [strip?.branch, strip?.folder, strip?.path, worktree, facesLoaded, t]);
  return strip === null ? null : <div ref={stripRef} className="composer-strip">
    {strip.folder !== null && <span className="composer-strip-item composer-strip-folder" title={strip.path ?? undefined}>
      {worktree ? <FolderGit2 aria-hidden="true" /> : <Folder aria-hidden="true" />}
      <span className="visually-hidden">{t("Working folder")}: </span>
      <span className="composer-strip-text composer-strip-folder-name">{strip.folder}</span>
      {strip.path !== null && <span className="composer-strip-text composer-strip-path">{strip.path}</span>}
      {worktree && <span className="composer-strip-kind">{t("Worktree")}</span>}
    </span>}
    {strip.branch !== null && <span className="composer-strip-item composer-strip-branch" title={strip.branch}>
      <GitBranch aria-hidden="true" /><span className="visually-hidden">{t("Branch")}: </span><span className="composer-strip-text">{strip.branch}</span>
    </span>}
  </div>;
}
