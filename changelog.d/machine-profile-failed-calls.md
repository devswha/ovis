### Changed
- The machine profile (a preview) answers a failed herdr call with its own code and sentence, in
  every HTTP answer and WebSocket frame: the bridge's own error codes and the herdr codes the app
  acts on are kept, any other is `herdr_error`, and such an answer is never stored. An ordinary
  server answers as before.
