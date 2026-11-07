# Third-party notices

The experiment's new source uses the repository's MIT license. The lockfile references public dependency artifacts without redistributing their archives or binaries.

## Deliberate standalone intercom dependency

The package lock selects `pi-intercom@0.17.3` from public repository `Strand-AI/pi-voice`, commit `900801dc48323e0f10151af68e0e5071772b69eb`, path `vendor/pi-intercom/pi-intercom-0.17.3.tgz`.

- URL: https://raw.githubusercontent.com/Strand-AI/pi-voice/900801dc48323e0f10151af68e0e5071772b69eb/vendor/pi-intercom/pi-intercom-0.17.3.tgz
- SHA-256: `ffe3d8921aea5edccb80e48285d1f713042ec80c7141e6e7b330055630555616`
- Integrity: `sha512-IZHpKNG7YoI3ufYDGwzcHy7Gup4mTQr/wmkRgvNbG4UWHBC29fsnJC+tqxhzg96RvcQ5MnTRU3Z7XsZD2mH/ig==`
- Provenance: derived from https://github.com/nicobailon/pi-intercom; the public containing repository documents its source binding in `docs/dependency-binding.md`.
- Required API: `pi-intercom/client`, `NativeIntercomClient`, exact session/epoch sends and reject-offline-delivery capability negotiation.

The public registry's `pi-intercom@0.18.1` archive does not contain that standalone client export. The registry release serves a different packaging boundary. Its other uses are outside this audit. Do not replace the selected artifact by version ordering alone.

The public containing repository is MIT-licensed by Strand AI. This experiment consumes only the separately licensed intercom archive. It neither copies the containing gateway/native source nor links a private package.

## Resolved closure

The lockfile resolves intercom `0.17.3`, tsx `4.23.15`, esbuild `0.28.2`, optional fsevents `2.3.3`, and 26 optional esbuild platform packages at `0.28.2`. All 30 public archives were downloaded and matched their locked SHA-512 integrity. Each archive's package manifest declares MIT. Intercom, tsx, esbuild and fsevents include the license texts below. The platform esbuild archives declare MIT but omit a separate license file. The main esbuild archive supplies the license. No downloaded executable or native module is committed.

An npm advisory audit reported zero known vulnerabilities at validation time. An advisory result is not a source-security review or a guarantee about future advisories. Re-audit when changing the lockfile.

## pi-intercom

```text
MIT License

Copyright (c) 2026 Nico Bailon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## tsx

```text
MIT License

Copyright (c) Hiroki Osame <hiroki.osame@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## esbuild and its platform packages

```text
MIT License

Copyright (c) 2020 Evan Wallace

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## fsevents

```text
MIT License
-----------

Copyright (C) 2010-2020 by Philipp Dunkel, Ben Noordhuis, Elan Shankar, Paul Miller

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
