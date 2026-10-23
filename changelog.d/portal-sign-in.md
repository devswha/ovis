### Added
- **Settings → Phone & devices → Portal** can put Portal's own sign-in in front of the address: a
  private link, an Ethereum wallet, or Google or company login (OpenID Connect), each with the
  names, wallets or accounts it lets in. Whoever gets through is let in like a paired device, with
  no access token asked, and Devices says who signed in. A private-link Portal offers **Invite
  someone**: a link for 1, 7, 30 or 90 days, shown once. Google or company login reads its client
  secret from `OVIS_PORTAL_OIDC_CLIENT_SECRET` and needs a Portal build that supports it; the panel
  says plainly when the installed `portal` does not. The default, the access token or a paired
  device, is unchanged.
- A browser that Portal's sign-in let in can sign out from **Settings → Devices**.
