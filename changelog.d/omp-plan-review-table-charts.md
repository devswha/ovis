### Added
- omp's plan mode shows in the chat: lines mark plan mode turning on, pausing, ending and the plan's
  approval, a proposed plan reads as "Plan ready for review" with View plan, and the plan file the
  agent writes or edits shows as the rendered document (diagrams included) instead of raw text.
- omp's Plan Review gets a card in the chat: the plan, View plan, and the review's own choices by
  name (Approve and execute, compact or keep context, Save, Refine plan once it has comments) plus
  Cancel. Each key is sent only after the screen shows the review and the expected row, and
  nothing is picked for you. omp's "Exit plan mode?" box reads as a Yes / No card.
- An omp answer's numeric table gets the chart omp's terminal draws under it, drawn by omp's own
  chart engine, so the chat no longer needs the terminal to see it.

### Fixed
- omp's Plan Review no longer shows as a generic "Waiting for input" card whose Enter approved and
  executed the plan.
