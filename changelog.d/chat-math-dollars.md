### Added
- Chat draws math written with dollar signs: `$…$` inline, `$$…$$` and a ```math fence as display
  math, beside `\(…\)` and `\[…\]`. A dollar sign reads as math only where a price cannot: after
  no letter or digit, with no space inside its ends, and not a number followed by a space, so
  "$5 and $10" stays as written. A formula KaTeX cannot draw shows as written.
