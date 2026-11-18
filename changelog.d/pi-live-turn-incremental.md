### Changed
- A pi or Command Code chat whose agent is still working no longer reparses the whole running
  task on every refresh: only the records written since the last refresh are read into it, as
  OMP, OMO, Claude and Codex chats already were, and pi's model catalog is checked once per read
  instead of once per answer.
