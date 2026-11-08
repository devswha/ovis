### Fixed
- The SSH list weighs Match blocks as ssh does (`host`, `originalhost`, `user`, `localuser`, `all`),
  and a host whose HostName depends on a condition it cannot weigh offline, such as `exec`, no
  longer claims a Tailscale PC. Neither does a host reached through ProxyJump or ProxyCommand.
- The SSH list leaves out a host named in an included file when the Include sits in a block that
  does not apply to that host, as ssh does.
- A changed hosts file or DNS answer counts the next time the SSH list opens, and the list's name
  lookups never pile up past 16 while a resolver hangs.
- A long Host pattern in the ssh config no longer stalls the server while the SSH list is read.
