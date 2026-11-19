### Fixed
- On herdr-core, answering a picker you opened (such as `/model`) while another card waits no
  longer ends that card's wait early and alerts it a second time, and a card answered before Ovis
  read it on screen stops showing as waiting at the first read without it, so its waiting alert
  no longer goes out after the answer.
