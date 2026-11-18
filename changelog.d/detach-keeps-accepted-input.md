### Fixed
- Keys and wheel scrolls sent to a terminal just before its page is hidden or its pane is left are
  no longer lost. They were answered as taken and then dropped, often all but the first of a quick
  burst, because the pane's connection to herdr was cut before herdr had read them; it now ends
  only once herdr has them, or after 2 seconds.
