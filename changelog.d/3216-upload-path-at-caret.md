### Fixed
- Chat: a pasted, picked or dropped image's path goes where it was pasted or picked (a drop: the
  start), following what is typed while it uploads, instead of always at the start of the message.
  Focus and the selection stay as they were, and files picked together keep their order. An image
  whose draft is cleared or replaced while it uploads is never put into the new one and never
  dropped: its tile shows a warning, the status line says it is not in the message, Send waits,
  and a click or tap in the text puts it there.
