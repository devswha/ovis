### Fixed
- Signing out of your account now wins over a sign-in, Sign in again or added sign-in method still
  on its way: its session is ended instead of kept, and a change to your sign-in methods waiting on
  it does not run. A sign-in the account service did not confirm ending is ended again later.
