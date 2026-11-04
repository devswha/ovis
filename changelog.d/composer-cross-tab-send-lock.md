### Fixed
- Two tabs of one browser pressing Send on the same pane at the same moment no longer send the
  message twice: the send claims the pane in a cross-tab lock where the browser offers one (HTTPS
  and localhost), and a tab whose draft another tab already sent no longer sends it again.
