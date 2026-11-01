### Fixed
- Panes show again on iOS 16 and Safari before 17.4, where every pane said "This pane can't be
  shown.": the app now brings its own copy of `Promise.withResolvers` and the other newer
  built-ins it uses.
