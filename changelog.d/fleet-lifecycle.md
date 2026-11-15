### Added
- The owner can remove a fleet machine for good (`ovis fleet remove`): its key is refused from then on,
  also with a fresh invite, until it is re-admitted (`ovis fleet readmit`). A quarantined slot is
  released with `ovis fleet release`, and open invites can be withdrawn (`ovis fleet invite --withdraw`).
- A machine that stays unseen past its batch's retention (`ovis fleet invite --retention`) is removed
  by itself.
- A state folder put back from an older backup is noticed: no machine signs in until the owner
  confirms the restored list (`ovis fleet confirm --restored`), which marks the machines removed or
  quarantined after the backup.
- `ovis fleet list` shows each machine's alerts, such as a second, silent session of its key; six
  within a day quarantine the key.
### Fixed
- `ovis fleet on` never leaves an owner key without its recovery phrase, even when it is
  interrupted.
