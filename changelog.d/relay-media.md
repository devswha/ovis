### Added
- Files and chat images load through the Ovis relay, including PDFs, rendered HTML pages and
  seekable videos in browsers. Clients without a service worker open files up to 64 MiB and
  explain when a file needs to be downloaded on the PC. Copied file links reopen the paired PC's
  reader, and rendered pages remain isolated from the app and its stored device keys.
