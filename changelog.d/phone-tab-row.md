### Changed
- A phone draws the workspace's tab row under the header, as every wider screen already did: the
  workspace's name leads it and opens the workspace drawer, the tabs scroll sideways, and the open
  tab is one tap away. The list of tabs behind the header's title is gone, so the pane is never
  covered to switch tabs. The row stays at every size, a single tab and a short screen included,
  drawn compact (36px) when the screen is short.
- A tab herdr still names by its number draws its pane's title instead, with herdr's number before
  it only where two tabs would otherwise read alike. herdr's own label is never written.
- A split tab's place in the header (`1/2`) is a button on a phone: it lists the tab's panes.
