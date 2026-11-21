### Maintenance
- A pull request whose changes cannot reach the browser jobs (unit tests, documentation, the terminal
  client, the phone and native apps' own folders, the workers, the installers, the runner launcher,
  another workflow) skips the Browser regression jobs; "Integration and browser" then passes on the
  integration tests. Any other path, and every push to `main`, runs them as before.
