### Fixed
- **Sign out every device** on an account with a signed list now puts this device out of the list
  too, after the other devices and before every sign-in ends, then forgets its account key. Before,
  this device kept its key and its place in the list, and a new sign-in brought it back with no
  Allow. A sign-in older than eight minutes is made again before anything is signed, and where this
  device could not leave the list nobody is signed out and the message says what went.
