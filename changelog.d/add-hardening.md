### Fixed
- `ovis add` and `ovis link --code` never write the QR code or the code to type to a pipe, a file
  or a log: where the output (or, for `add`, the input) is not a terminal, they say in one line
  that a terminal is needed. `--print` writes plain lines on a terminal only.
- `ovis add` names the account that signed in (its id and the provider) and shows the QR code only
  after Enter is pressed at that name, so a sign-in someone else approved is seen before anything
  is shown or listed.
- `ovis add` no longer says "every device of your account can use it" while a device in no account
  can use the PC too, one paired before the run included. It names each such device with when it
  paired; run again on a PC already in an account, it offers to revoke them after the word yes.
  The check is the last step before the success line, which says what held when it was checked.
- `ovis pair` (and Phone setup) write the pairing code and relay link to a terminal only. `add`,
  `link`, `login`, `pair` and Phone setup always run from the plugin's own copy, never from an
  installed release or the compiled server's bundled command line.
- `ovis add` waits a minute, not 30, for a phone that paired but never adds the PC: it says so and
  how to finish, and stops with exit code 3 unless you type wait.
- When your account holds as many PCs as it can, `ovis add` says so and how to free a place,
  instead of the account service's bare `409 (directory_full)`.
