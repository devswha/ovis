# The account layer's licence

> **This head is not part of the licence; the text below the line is.**

**What it covers.** Every file under `shared/account-list*`: the signed list of an account's devices and machines, its
library, the library's tests and its test vectors. The glob decides, not a list, so a file added there later is born
under this licence. Each `.ts` file starts with `// SPDX-License-Identifier: FSL-1.1-MIT`. The JSON test vectors in
`shared/account-list-vectors/` cannot hold a comment and must not gain a field, so [`REUSE.toml`](../REUSE.toml) names
their licence. `scripts/account-layer-licence.test.ts` fails for a file under the glob that has neither. The rest of
this repository's own code is under the MIT License in [LICENSE](../LICENSE).

**Source available.** This part is source available: FSL-1.1-MIT is not an OSI-approved licence.

**In plain words** (the licence text below decides):
- Anyone may read these files, change them, and use them for himself and inside his company, for non-commercial
  education and research, and in professional services to someone who uses them under this licence.
- No one but us may offer them, changed or not, to others in a commercial product or service that takes the place of
  the software, takes the place of a service we offer with it, or does much the same.

**Each version becomes MIT** two years after it is made available.

The text below is the template at https://fsl.software/FSL-1.1-MIT.template.md (the same text as
https://spdx.org/licenses/FSL-1.1-MIT.html), word for word; only its notice's year and licensor are filled in, the
licensor as the root LICENSE names the copyright holder.

---

# Functional Source License, Version 1.1, MIT Future License

## Abbreviation

FSL-1.1-MIT

## Notice

Copyright 2026 devswha

## Terms and Conditions

### Licensor ("We")

The party offering the Software under these Terms and Conditions.

### The Software

The "Software" is each version of the software that we make available under
these Terms and Conditions, as indicated by our inclusion of these Terms and
Conditions with the Software.

### License Grant

Subject to your compliance with this License Grant and the Patents,
Redistribution and Trademark clauses below, we hereby grant you the right to
use, copy, modify, create derivative works, publicly perform, publicly display
and redistribute the Software for any Permitted Purpose identified below.

### Permitted Purpose

A Permitted Purpose is any purpose other than a Competing Use. A Competing Use
means making the Software available to others in a commercial product or
service that:

1. substitutes for the Software;

2. substitutes for any other product or service we offer using the Software
   that exists as of the date we make the Software available; or

3. offers the same or substantially similar functionality as the Software.

Permitted Purposes specifically include using the Software:

1. for your internal use and access;

2. for non-commercial education;

3. for non-commercial research; and

4. in connection with professional services that you provide to a licensee
   using the Software in accordance with these Terms and Conditions.

### Patents

To the extent your use for a Permitted Purpose would necessarily infringe our
patents, the license grant above includes a license under our patents. If you
make a claim against any party that the Software infringes or contributes to
the infringement of any patent, then your patent license to the Software ends
immediately.

### Redistribution

The Terms and Conditions apply to all copies, modifications and derivatives of
the Software.

If you redistribute any copies, modifications or derivatives of the Software,
you must include a copy of or a link to these Terms and Conditions and not
remove any copyright notices provided in or with the Software.

### Disclaimer

THE SOFTWARE IS PROVIDED "AS IS" AND WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING WITHOUT LIMITATION WARRANTIES OF FITNESS FOR A PARTICULAR
PURPOSE, MERCHANTABILITY, TITLE OR NON-INFRINGEMENT.

IN NO EVENT WILL WE HAVE ANY LIABILITY TO YOU ARISING OUT OF OR RELATED TO THE
SOFTWARE, INCLUDING INDIRECT, SPECIAL, INCIDENTAL OR CONSEQUENTIAL DAMAGES,
EVEN IF WE HAVE BEEN INFORMED OF THEIR POSSIBILITY IN ADVANCE.

### Trademarks

Except for displaying the License Details and identifying us as the origin of
the Software, you have no right under these Terms and Conditions to use our
trademarks, trade names, service marks or product names.

## Grant of Future License

We hereby irrevocably grant you an additional license to use the Software under
the MIT license that is effective on the second anniversary of the date we make
the Software available. On or after that date, you may use the Software under
the MIT license, in which case the following will apply:

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
