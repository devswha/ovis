// Ovis for Mac runs this in its main window's page as each page commits (TitleBar.swift): the window
// draws no title bar there, and the page's header takes its place. `height` is the bar's height and
// `inset` the traffic lights' right edge, as AppKit laid them out: the header takes that height and
// starts clear of the lights (`[data-mac-title-bar]` in src/styles.css). A press on the header's bare
// surface, off its controls and menus, asks the app to move the window once the mouse moves
// (`post("drag")`), and a double click there does what a title bar's does (`post("zoom")`). A window
// the page opened keeps its title bar and runs none of this.
function ovisTitleBar(document, height, inset, post) {
  const root = document.documentElement;
  // once per page: the app runs it as the page commits and again once the window's bar is folded
  if (!root || root.dataset.macTitleBar !== undefined) return;
  root.dataset.macTitleBar = "";
  root.style.setProperty("--mac-title-bar-h", `${height}px`);
  root.style.setProperty("--mac-title-bar-inset", `${inset}px`);

  const CONTROLS = "button, a, input, select, textarea, label, summary, [tabindex], [contenteditable], [role=button], [role=link], [role=tab], [role=group], [role=menu], [role=menuitem], [role=dialog], [role=listbox], [role=option]";
  // walked up to the header itself: a control or an open menu on the way keeps the press the page's
  const bare = (target) => {
    for (let node = target; node && typeof node.matches === "function"; node = node.parentElement) {
      if (node.classList.contains("app-header")) return true;
      if (node.matches(CONTROLS)) return false;
    }
    return false;
  };
  document.addEventListener("mousedown", (event) => {
    if (event.button === 0 && event.detail === 1 && bare(event.target)) post("drag");
  }, true);
  document.addEventListener("dblclick", (event) => {
    if (event.button === 0 && bare(event.target)) post("zoom");
  }, true);
}
