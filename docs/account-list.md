# The signed list: an entry

No released part of Ovis reads or writes this format yet: the account as it works today signs its
records one by one, with no chain ([Linking devices with an account](account.md#rules)).

An owner's devices and machines share one signed list. Every member keeps a copy and checks every
entry by itself; the account service stores entries and must never be able to write one that
members accept. This page says how one entry is written, signed, hashed and chained, and how a
member checks it. Who may sign an entry (the signers) is checked on top of this and is not part of
this page. The code is [`shared/account-list-entry.ts`](../shared/account-list-entry.ts); the
vectors are in [`shared/account-list-vectors/envelope/`](../shared/account-list-vectors/envelope).
What each kind of entry means, and the state the entries build, is under [The kinds](#the-kinds);
the code for that is [`shared/account-list.ts`](../shared/account-list.ts).

## The form

An entry is two byte strings, a **body** and a **signature**. The body is what is signed, hashed,
stored and sent; nobody re-encodes an entry, so two members never differ over its bytes. A body is
never read or written through JSON.

```
body  = "ovis-list/1" field field ...       at most 8192 bytes in all
field = len(name) name len(value) value     len(x) = the number of bytes of x, as 4 bytes, big-endian
name  = 1 to 32 bytes: the first is a-z, each other is a-z or _
value = 0 or more bytes
```

- Names ascend strictly, compared byte by byte: no name comes twice, and a name that is the start
  of another comes before it.
- The body ends exactly after its last field. A body cut inside a length, a name or a value, or
  with bytes after its last field, has not this form.
- 8192 bytes is the one size limit of an entry: no member takes a longer body.

Seven fields are in every entry, three more may be, and every other field belongs to the entry's
kind: for such a field only the name is checked, never the value.

| name | in | value |
|---|---|---|
| `issued_at` | every entry | when it was signed, by the signer's clock: seconds since 1970-01-01 UTC, a number |
| `kind` | every entry | 1 to 32 bytes in the form of a name |
| `list` | every entry | the list id; empty in entry 0 |
| `prev` | every entry | the hash of the entry before; empty in entry 0 |
| `seq` | every entry | the entry's place, counted from 0, a number |
| `signer` | every entry | the signer's key |
| `v` | every entry | the level that first defined this kind in this form, a number from 1 |
| `adds`, `power` | together or not at all | a key that becomes a signer, and its power: `full` or `bound` |
| `ends` | or absent | a key that stops being a signer |

- A **key** is a P-256 public key: 122 characters of `A-Z a-z 0-9 - _`, the base64url (no
  padding) of 91 bytes, in its one spelling (decoding and encoding again gives the same 122
  characters). The 91 bytes are `3059301306072a8648ce3d020106082a8648ce3d03010703420004` (hex)
  and the point's X and Y. Keys are compared as these 122 bytes. A point that is not on the curve
  (X or Y not below p, or Y² not X³ - 3X + b mod p) is a key in form that signs nothing.
- A **number** is 1 to 15 digits `0-9`, with no sign and no leading zero (zero is `0`).
- A **hash** is 64 characters `0-9a-f`.

A body lacks the form when one of the seven fields is missing, when a value is not in the form the
table names (`v` `0`, a `power` that is neither `full` nor `bound`, an `adds` or `ends` that is no
key, a `list` or `prev` that is neither a hash nor empty), or when `adds` stands without `power`
or `power` without `adds`. Whether a key may stand in `adds` or `ends` is not a question of form.

## The signature, the hash and the list id

- The **signature** is ECDSA P-256 with SHA-256 over the body, under `signer`: `r || s`, 64 bytes.
  Any `r` and `s` from 1 to n-1 that verify count, an `s` above n/2 included. A `signer` whose
  point is not on the curve verifies nothing; the library judges that, like the range of `r` and
  `s`, before it asks the runtime, so that no runtime's way of refusing a key decides. What the
  runtime then throws, and a runtime with no WebCrypto at all (a page on plain http at a LAN
  address), is a fault, never a verdict on the entry.
- The **entry hash** is SHA-256 over `ovis-list-entry/1` and the body, as a hash. It covers the
  body only, so two entries are the same entry when their hashes are equal, whatever their
  signatures. Where `r || s` verifies, `r || n-s` verifies too, and anyone can write it without
  the key, so one body can come with two signatures and as two texts: nothing may identify an
  entry by its signature bytes or its text, only by its entry hash.
- The **list id** is the hash of entry 0.

## On the wire and in files

An entry is one text: the base64url of its body, `.`, and the base64url of its signature, each
without padding in its one spelling, and nothing else; the signature part is 86 characters. Inside
JSON it is a JSON string. A text with no dot or a second dot, an empty part, a character outside
`A-Z a-z 0-9 - _` (padding, white space, a trailing newline), a signature part of another length,
or a second spelling of either part is refused. The body it carries is then checked as above.

## When an entry holds

Entry n holds when, in this order:

1. its body has the form above;
2. its `seq` is n; for entry 0, `list` and `prev` are empty and it carries no `adds` and no `ends`;
   for a later entry, `list` is the list id and `prev` is the hash of entry n-1;
3. its signature verifies.

The check needs the list id and the entry before, and nothing else. A member that was given a list
id (by an offer or a join line) takes as entry 0 only the entry with that hash. An entry that does
not hold stops the member with the code of the first check that fails:

| code | when |
|---|---|
| `entry_malformed` | 1: the body, the text or the signature's 64 bytes have not the form |
| `chain_broken` | 2: a wrong `seq`, `prev` or `list`, an entry of another list, an entry 0 with a `list`, a `prev`, `adds` or `ends` |
| `signature_invalid` | 3: the signature does not verify: a changed byte, a signature by another key, an `r` or `s` outside 1 to n-1, a `signer` whose point is not on the curve |
| `list_mismatch` | an entry 0 that holds but is not the one with the list id the member was given |

## Levels

A level is a number from 1; a build of level L reads every form of levels 1 to L. Each kind writes
in `v` the level that first defined it in that form. Level 1 is nine kinds, each written with `v`
1: `genesis`, `device`, `pc`, `invite`, `join`, `remove`, `carried`, `card` and `epoch`.

## The kinds

The members of a list are **devices** (a phone, a desktop app, a browser) and **PCs**. Every member
has a signing key; a PC is also known by its relay key, the key a device already holds it to when
it connects. An **invite** is a key too. Who may sign an entry is the signers' rule, from `adds`,
`power` and `ends` alone: a signer of power `full` adds and ends any key, one of power `bound` ends
only itself, and a key that was ever a signer is never added again. The kind says what the entry
means on top of that.

| kind | signed by | carries | it means |
|---|---|---|---|
| `genesis` | the first device, as entry 0 | `account`, `enc`, `epoch_opens`; names | the list starts for that account; its signer is the first device, `full`, with role `drive`; epoch 0 is open |
| `device` | a `full` signer | `adds` and `power`; `card`, `enc`, `role`, and `until` or not; names | the key in `adds` is a device with that power and role |
| `pc` | a `full` signer | `adds` with power `full`; `card`, `enc`, `endpoint`; names | a person added the PC at that relay key; the key in `adds` is its signing key |
| `invite` | a `full` signer | `adds` with power `bound`; `auto`, `exp`, `uses`; names | the key in `adds` is an invite |
| `join` | an invite's key | `card`, `enc`, `endpoint`, `pc`; names | the PC at that relay key joins by itself; `pc` is its signing key, which is no signer |
| `remove` | see below | `ends`, or `endpoint` | the key, or the PC at that relay key, is out |
| `carried` | the first signer | `adds` with power `full`, `role`; or `endpoint`; names | a device, or a PC, that was in the account before it had a list |
| `card` | a device with no encryption key yet | `enc` | the device names its encryption key |
| `epoch` | a `full` signer | `epoch`, `epoch_link`, `epoch_opens` | the epoch after the current one is open |

"names" is the two fields `sealed` and `epoch`, which come together or not at all: an entry whose
writer holds no key to seal its names with carries neither, and counts all the same.

| field | value |
|---|---|
| `account` | the account's id: 1 to 64 of `A-Z a-z 0-9 _ -` |
| `auto` | `1` for an invite a PC joins with by itself, `0` for one that needs a person to add the PC |
| `card` | a [card](#a-card)'s signature: 86 characters of base64url, `r \|\| s` |
| `enc` | an encryption key: [a key](#the-form) whose point is on the curve |
| `endpoint` | a PC's relay key: 64 of `0-9a-f` |
| `epoch` | a number: the epoch whose key sealed this entry's names; in an `epoch` entry, the epoch that is current where it stands |
| `epoch_link` | 61 bytes: the key of the current epoch, under the key of the epoch the entry opens |
| `epoch_opens` | a hash: the commitment to the key of the epoch the entry opens (epoch 0 in a `genesis`) |
| `exp` | a number, at most `issued_at` and 604800 (7 days). Only the account service judges it against a clock |
| `pc` | a PC's signing key: a key whose point is on the curve |
| `role` | `drive` (types into terminals) or `watch` (only reads them) |
| `sealed` | the entry's [names](#what-is-sealed), sealed: at least 47 bytes |
| `until` | a number: a PC lets the device in only before this second, by the PC's own clock |
| `uses` | a number from 1 to 256: how many PCs may join with the invite |

An entry is of its kind only with exactly those fields, each in its form, and with `adds` and `ends`
only where the table has them. One exception: a `device` may carry `ends` when it names the entry's
own signer, which so hands its place to the key in `adds` in one entry. Anything else is not of its
kind and has no effect of it (`entry_invalid`); its `adds` and `ends` have applied all the same, so
the key it adds is a signer with no name: it may sign what its power allows, and it opens nothing
and is no device and no PC.

What the kinds add to the signers' rule:

- **A PC that a person added is a signer of power `full`**, so a person at that PC can allow a
  device, add a PC and remove a member. It is in while its key is a signer: the entry that ends the
  key puts the PC out, whatever its kind. Its relay key alone does not put it out (`ends_needed`),
  since that would leave its key a signer.
- **A PC that joined by an invite is no signer.** A `join` counts only when its signer is an open
  invite with `auto` `1`. Such a PC lets devices in and can allow nobody. An invite with `auto` `0`
  lets no PC in by itself (`invite_not_auto`): the PC asks with its line, and a member's `pc` adds
  it.
- **An invite is open** while its key is a signer, whoever placed it is one, and fewer PCs joined
  with it than `uses`. Otherwise its join takes the first name that applies: `invite_unknown`,
  `invite_revoked`, `invite_void`, `invite_spent`.
- **A relay key comes in once** (`endpoint_reused`), also after its PC was put out. One row waits
  for more: a carried PC that is still in gets its keys from a person's `pc` at its relay key, and
  never from an invite's `join`. **A PC's key comes in once**, at one relay key, and a key that is
  or was a signer is no PC's (`key_reused`).
- **`remove` with `endpoint`** puts out a PC whose key is no signer (one that joined or was
  carried), and only a `full` signer's does (`signer_not_allowed`, then `already_out`).
- **`carried`** counts only from the first signer (`signer_not_allowed` from anyone else): it is
  how the device that starts a list for an account that was in use names who was in it. A carried
  device has no encryption key until its own `card` names one, once (`enc_set` after that).
- **Names are sealed under the current epoch.** An entry whose `epoch` is another has no effect
  (`epoch_other`): under an earlier key a member that was put out could read the names, and under a
  later one nobody can. Only an `epoch` entry of a `full` signer opens the next epoch, and only when
  it names the current one, so of two members that open it at once one does. A removal opens none
  by itself: whoever puts a member out places an `epoch` entry after the `remove`, and a member
  that signs itself out leaves that to one that stays.
- **A member judges no time but one.** A device with `until` is let in only before that second by
  each PC's own clock; it stays a signer of its power after it, and so can still end itself.

A member that reads an entry whose `v` is above its level applies `adds` and `ends` and nothing of
the kind, and from an entry of a `full` signer that it cannot read it is behind: it lets nobody new
in, and still applies every removal.

### A card

A newcomer has no say in the list before it is in it. So it states what nobody else may choose for
it under its own signature, and the entry that lets it in carries that signature in `card`:

```
bytes = "ovis-list-card/1" and the fields enc, key and list, for a PC endpoint, and for a PC that joins by an invite invite, in the form of a body's fields
```

- `key` is the newcomer's signing key (the `adds` of a `device` or `pc`, the `pc` of a `join`),
  `enc` its encryption key, `list` the list id, `endpoint` the PC's relay key, and `invite` the key
  of the invite that signs the `join`.
- The signature is `key`'s, ECDSA P-256 with SHA-256 over those bytes, checked as an entry's is.
- A `device`, `pc` or `join` whose card is not that of its key, for its `enc`, this list, its
  `endpoint` and its invite, has no effect (`card_invalid`). So nobody can name a key that never
  asked to join, give a member an encryption key that is not its own, move a card to another list,
  or take the card a PC made for a person to add it and join that PC by an invite instead.
- A device that was carried in was not there to sign a card: its `card` entry, signed with its own
  key, says the same.

### What is sealed

A member's name and OS word are not needed to decide who is in, so they are not in the clear: the
entry carries them in `sealed`, encrypted under the key of an epoch, which the members share and
the account service never has. How they are sealed and how members share the keys is not part of
this section. No rule above reads `sealed` beyond its length, or needs a key: so a member that was
given no key to the names, or a wrong one, lets in and puts out exactly whom every other member
does, and so does the account service.

What is sealed is fields in the form of a body's fields: `label`, and `os` when the OS is known.
`label` is a name: 1 to 48 UTF-16 units, no control character, no unpaired surrogate, and of white
space only single spaces inside it. `os` is one of `ios`, `android`, `macos`, `windows`, `linux`,
`chromeos`. A reader takes an OS word it does not know as none and passes by a field it does not
know, so a later build may say more.

An **epoch** is the time one such key is in use. Entry 0 opens epoch 0, and each `epoch` entry
opens the next. What opens an epoch says two things of it in the clear: `epoch_opens`, a commitment
to its key, so that a member takes a key for that epoch from nobody unless it gives this
commitment; and `epoch_link`, the key before under the new one, so that a member given the current
key reads the names of every earlier epoch.

In the clear are the keys, the relay key of each PC, each role and `until`, each invite's `exp`,
`uses` and `auto`, and the epochs' numbers: the account service sees how many devices and PCs an
account has and when each came and went, and not what they are called.

### The state

A member's state is plain data that JSON holds: the signers' state, and beside it

| part | named by | holds |
|---|---|---|
| `signers` | key | each signer's row, with `as`: `device`, `pc`, `invite`, or none |
| `devices` | key | `role`, `until`, `enc` (none for a carried device that has not named it), `carried` |
| `pcs` | relay key | `how` (`added`, `joined` or `carried`), `key`, `enc`, `seq`, `invite`, `removed` |
| `pc_keys` | key | the relay key of the PC that has or had this key |
| `invites` | key | `exp`, `uses`, `joins`, `auto` |
| `epoch`, `epochs` | number | the current epoch's number; for each epoch `opens`, `link` (none for epoch 0) and `seq`, the place of the entry that opened it |

Nothing is ever deleted. A device or an invite is in while its key is a signer, and a PC while its
`removed` is empty. A PC lets a device in while the device is in and, when it has an `until`, before
that second, as what its `role` says. The key of an epoch is wrapped to the encryption key of each
device and PC that is in, and to the own key of each open invite with `auto` `1`, so that a PC
which joins with nobody else awake can read the names and seal its own. A member that stopped for
a replay answers for nobody until it has replayed.

Every entry that holds comes to one of these, the same for every member of one level and for the
account service:

| outcome | when |
|---|---|
| `passed_over` | the signers' rule passes it over: nothing in it applies (`signer_unknown`, `signer_not_allowed`, `key_reused`, `already_out`; a `join` takes its invite's name) |
| `stops` | a member that is behind cannot place it, and takes nothing until it replays (`needs_replay`) |
| `cannot_read` | its `v` is above the member's level: `adds` and `ends` have applied, the kind does nothing |
| `no_effect` | `adds` and `ends` have applied, and the kind does nothing, by the first of: `entry_invalid`; `epoch_other`; what the list holds (`invite_unknown`, `invite_revoked`, `invite_void`, `invite_spent`, `invite_not_auto`, `signer_not_allowed`, `already_out`, `ends_needed`, `endpoint_reused`, `key_reused`, `enc_set`); `card_invalid` |
| `counts` | the kind's rule counts it |

### Reading the log with an invite

A machine that holds a join line is no member yet and still has to read the log. It proves that it
holds the invite: `ovis-list-read/1` and the fields `after` (the place its page follows, or empty
for the start), `at` (when it was made), `key` (the invite's key) and `list`, in the form of a
body's fields, signed with the invite's key and written as one text like an entry. The account
service checks the form (`proof_malformed`), then the signature (`signature_invalid`), then what
the list holds of that invite, and judges `at` and the invite's `exp` by its own clock.

## The vectors

Each file of [`shared/account-list-vectors/envelope/`](../shared/account-list-vectors/envelope) is
one JSON object: `name`; `given_list`, only when the member was given a list id; `keys`, the test
keys (base64url `pkcs8` and `spki`, each named `TEST-ONLY-...`: never use them outside tests);
`entries`, in order, each with `fields` (the body's fields as text, for a reader), `body` and
`signature` (base64url), `text` (the entry on the wire, which is what a reader reads) and `hash`;
and `expect`: either `state` (`{ list, head: { seq, hash }, first_signer }` after the last entry)
or `stops` (`{ seq, code }`: the place of the entry that does not hold and its code). Every `text`
that reads is `body`, `.`, `signature`; the `wire-` vectors carry a `text` that does not read,
beside the entry it was made from. ECDSA signatures are random, so a vector fixes the body, the
hash and one signature to verify; nobody is asked to reproduce a signature. Two implementations
agree on this page when both give every vector's `expect`.

Each file of [`shared/account-list-vectors/kinds/`](../shared/account-list-vectors/kinds) is a list
from entry 0: `name`, `level` (the member's), `keys`, `entries` as above (`sealed` is shown as
base64url), and `expect`: either `outcomes` (what became of each entry after entry 0, as
`counts`, `cannot_read`, or the outcome and its name) with the whole `state` after the last entry,
or `stops`. [`card/`](../shared/account-list-vectors/card) holds cards (`card`, its `bytes` where
it is in form, a `signature`, `expect.holds`) and [`names/`](../shared/account-list-vectors/names)
holds names (`fields`, each a name and its value as base64url, and `expect.names`, which is `null`
for fields that give none; `written` says that a writer writes exactly those fields for those
names).

## The list routes in tests

The account service stores and serves the list; a member trusts none of its answers for who is in.
Tests reach the service's list routes (`/v2`) through the in-memory service in
[`shared/account-service-fake.ts`](../shared/account-service-fake.ts), on the same accounts,
sign-ins and PCs as its `/v1` routes. It runs this page's library on every entry it is asked to
place, as the service does, so a test fails where a client relies on something the service would
refuse. The tests in
[`shared/account-service-fake.list.test.ts`](../shared/account-service-fake.list.test.ts) show
every route in use.

- **The switch.** `listAccounts` stands for the service's `OVIS_LIST_ACCOUNTS`: account ids
  separated by commas, or `*` for every account. It is empty by default, and then every `/v2` route
  answers `404 not_found` as an unknown one and the mailbox's `with_list` says `list: null`. A test
  sets it first.
- **Devices** call by bearer: `POST /v2/lists` (entry 0), `GET /v2/lists/mine`, and under
  `/v2/lists/{list}/`: `GET log?after=&limit=`, `GET wraps?member=`, `POST entries`, `POST claims`,
  `GET claims`, `GET posts`. A write takes an app's own sign-in that no block freezes. A genesis and
  a claim also take a sign-in made in the last ten minutes, or an older one with a key proof: a
  challenge of `POST /v1/pcs/challenge` (with `opensAll` on), signed by the key that sign-in
  registered over `pcAddSigningBytes` (`shared/account-records.ts`) with the purpose `list-genesis`,
  the list id in the place of the server_id and no listing, or `list-claim` with the claimed key as
  the listing.
- **PCs** prove their relay key in the body of each call (a challenge of `POST /v1/pc/challenge`
  answered with the role `account`, one per call): `POST /v2/pc/list`, `/v2/pc/list/log`,
  `/v2/pc/list/wraps`, `/v2/pc/list/entries` and `/v2/pc/list/keys`. A mailbox pull with
  `with_list: true` also gets the list's id and head.
- **What a placement checks**, in order, nothing stored on a refusal: every text in its form, and
  the first at the head (`409 head_moved` names the head; a batch already in the log text for text
  is `200` with `placed: 0`); then entry by entry, that it holds and counts for the library
  (`entry_refused` with its `outcome` and `reason`), and what only the service judges: no `carried`
  yet, an `invite` only from a sign-in and not dated ahead of its clock, a `join` before its
  invite's `exp` and only from the PC it names, the list's size; then the second lock (a `device`
  needs a live claim of its key, a `pc` a live post of its keys by a PC the account lists, each
  used up by the entry), the wraps, and the budget of additions. Two writers at one head: one is
  placed. A batch whose every entry is a `remove` signed by a signer of the list spends that
  signer's own counter instead of the account's requests.
- **Limits** are in `listLimits`, which a test may lower to reach `list_full`, `entry_budget` or a
  PC's calls a minute.
- `accountList(account)` gives what the service holds, no lie applied: the list id, every entry's
  text, the head, the service's own state of the list, every stored wrap, and the claims and posts
  that still lock.

### Making the service lie

A member must come to no harm from anything the service says, so the fake lies when a test asks
it to: `tamperList(list, lie)` adds a lie and `untamperList(list)` ends them all. Nothing lies by
default, and a lie changes only what is served or refused: the log the fake holds stays as placed.
`reader` (`{ token }` for a device's sign-in, `{ server_id }` for a PC) lies to that reader alone,
and to everyone when it is left out.

| lie | what is served | what a test proves with it |
|---|---|---|
| `inject` | these texts after the log, the head moved to the last | an entry of a key that is no member is passed over and lets nobody in |
| `wraps` | these wraps in place of the stored ones | a wrap of a key of the service's own is refused against `epoch_opens` |
| `withholdAfter` | the log up to that seq, its head with it | a removal that never arrives (one reader), or an old prefix replayed (every reader): a member never goes back |
| `head` | that head in every answer | a head the log does not reach shows the tail withheld; an old head changes nothing |
| `fork` | these texts in place of the log from the first one's seq on | two readers each hold a valid history at the same seq, which only comparing heads parts |
| `pages` | pages that end after these seqs | a reader joins the same log wherever the pages are cut |
| `answerList` | another list under this list's id | its entry 0 is not the list the member pinned (`list_mismatch`) |
| `listId` | that id as the account's list, the log unchanged | the id is a hint: a member pins it only from another member |
| `flipEntry`, `flipWrap` | one byte flipped in that entry's body or that wrap | the entry no longer holds; the wrap does not open |
| `headMoved` | `409 head_moved` for every placement | a writer stops after its own bound and says so |
| `dropWraps` | a placed batch's entries without its wraps | a member with no wrap sees no names and is let in all the same |
