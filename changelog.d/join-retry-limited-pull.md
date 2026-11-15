### Fixed
- A PC joining the account while many machines behind the same address join with it no longer stays
  waiting when the account service briefly limited another PC's mailbox check: the joining device
  waits as long as the service asked (at most a minute) and asks once more. Meanwhile the open PC
  says so in one line, counting the seconds down.
