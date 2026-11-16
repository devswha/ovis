### Added
- The entry format of an account's signed list: a library with its test vectors and a page that
  describes it ([docs/account-list.md](docs/account-list.md)). No released part of Ovis reads or
  writes the format yet, so Ovis behaves as before. The files under `shared/account-list*` are not
  under the MIT License: they are source available under the Functional Source License
  (FSL-1.1-MIT, [LICENSES/ACCOUNT-LAYER.md](LICENSES/ACCOUNT-LAYER.md)), and each version of them
  becomes MIT two years after it is made available. Everything else stays under the MIT License.
