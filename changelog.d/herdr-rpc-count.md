### Maintenance
- `HERDR_RPC_COUNT=1` counts the server's calls to herdr's socket API per method and, when the
  server stops, writes the tally as one line to its log. It is off unless set to exactly `1`, and
  the counts go nowhere else.
