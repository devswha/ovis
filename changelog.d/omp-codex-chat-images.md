### Added
- Chat shows the pictures in an omp session: one sent with a prompt, a prompt that is only a
  picture (as a turn of its own), and one a tool such as `read` returned. omp keeps their bytes in
  its blob store; Chat reads them from there and serves only bytes that match the name omp gave
  them.
- Chat shows a picture a Codex tool returned (`view_image`, an image generation, a screenshot a
  command read) in that tool's row, loaded when the row is opened.
