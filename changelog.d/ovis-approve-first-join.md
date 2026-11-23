### Fixed
- A PC with no screen can now let in the first phone that opens it after `ovis add`. That phone's
  request carries six digits only the PC itself may accept, and `ovis approve` used to skip it and say
  no device was waiting. Now `ovis approve` names the device, its account and when it asked, and lets it
  in once the six digits it shows are typed. `ovis add` at a terminal goes on after "Added." and asks
  for those digits itself; without a terminal it says to run `ovis approve`.
