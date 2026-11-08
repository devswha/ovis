### Fixed
- An Include wildcard in the ssh config (`Include conf.d/*/*`) no longer lists or walks a folder
  linked from outside the home folder, even one swapped in after it was checked; the hosts such a
  folder could change claim no PC. A wildcard looks at 1024 folder entries at most across the config.
  On macOS and Windows a wildcard Include's folders are listed by path, and any host the files found
  that way name or set an option for is listed without claiming a Tailscale PC.
- The SSH list keeps the files a wildcard matches in ssh's order, and claims nothing for a host that
  an Include of another user's home (`~user`) or a pattern it cannot match exactly (`[[:digit:]]`)
  could change.
- The SSH list keeps a row for each Tailscale PC it lists within its 200-row limit, so many config
  hosts (such as ones a skipped Include leaves undetermined) no longer push a PC off the list.
