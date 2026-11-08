### Fixed
- An Include wildcard in the ssh config (`Include conf.d/*/*`) no longer lists or walks a folder
  linked from outside the home folder; the hosts such a folder could change claim no PC.
- The SSH list keeps a row for every Tailscale PC within its 200-row limit, so many config hosts
  (such as ones a skipped Include leaves undetermined) no longer push a PC off the list.
