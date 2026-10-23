### Added
- **Settings → Phone & devices → Portal** can put Portal's own sign-in in front of the address: a
  private link, an Ethereum wallet, or Google or company login (OpenID Connect), each with the
  names, wallets or accounts it lets in. Whoever gets through is let in like a paired device, with
  no access token asked, and Devices says who signed in. A private-link Portal offers **Invite
  someone**: a link for 1, 7, 30 or 90 days, shown once. The app believes who Portal signed in
  only with a proof it hands that Portal in its environment, so other ways to the app's port cannot
  pass for it. A sign-in needs a Portal build that lists `--auth-identity-proof` (none of the
  releases so far does), and Google or company login also its OIDC flags; the panel says plainly
  when the installed `portal` does not. Google or company login reads its client secret from
  `OVIS_PORTAL_OIDC_CLIENT_SECRET`. The default, the access token or a paired device, is
  unchanged.
- A browser that Portal's sign-in let in can sign out from **Settings → Devices**.
