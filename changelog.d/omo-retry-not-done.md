### Fixed
- An OmO that Ovis started stays RUN while it retries a request the model provider failed,
  instead of reading DONE with a failure alert at the first failed attempt; it reads DONE (or
  failed) once OmO answers or gives up, and a turn's DONE comes as soon as OmO ends it.
