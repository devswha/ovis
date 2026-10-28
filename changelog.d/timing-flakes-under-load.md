### Maintenance
- Three tests that failed on busy hosts with nothing wrong in the code now measure what the code
  controls: the browser lane's stubbed runs get a hang guard instead of a 5 s limit (#2110), the
  Codex matcher's bounded-time cases count this thread's CPU time and fail on a quadratic scan
  (#2142), and the OpenCode first-key gap is measured from the send's own last request (#2143).
