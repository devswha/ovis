# The signed list: an entry

No released part of Ovis reads or writes this format yet: the account as it works today signs its
records one by one, with no chain ([Linking devices with an account](account.md#rules)).

An owner's devices and machines share one signed list. Every member keeps a copy and checks every
entry by itself; the account service stores entries and must never be able to write one that
members accept. This page says how one entry is written, signed, hashed and chained, and how a
member checks it. Who may sign an entry (the signers) is checked on top of this and is not part of
this page. The code is [`shared/account-list-entry.ts`](../shared/account-list-entry.ts); the
vectors are in [`shared/account-list-vectors/envelope/`](../shared/account-list-vectors/envelope).

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
in `v` the level that first defined it in that form. Level 1 is five kinds, each written with `v`
1: `genesis`, `device`, `invite`, `join` and `remove`. What each kind carries and means is not part
of this page.

## Names the service cannot read

The account service stores the list and must not read the names in it: a device's label, a PC's
address, an operating system. A kind puts those fields into one field, `sealed`, encrypted under
the list's current **epoch key**, and every member holds that key **wrapped** to an encryption key
of its own. The service keeps the wraps beside the list and can open none of them.

Nothing of this section is part of when an entry holds, and who is a member never depends on it: a
wrap or a sealed field that does not open hides a name, and nothing else. Which fields a kind seals
and what it calls the clear fields named below belongs to the kinds. The code is
[`shared/account-list-seal.ts`](../shared/account-list-seal.ts); the vectors are in
[`shared/account-list-vectors/seal/`](../shared/account-list-vectors/seal).

```
number(n) = n as 8 bytes, big-endian            a seq or an epoch: 0 to 999999999999999
id(list)  = the 32 bytes the list id spells     for entry 0, which has no list id yet: 32 zero bytes
key(k)    = the 91 bytes a key spells
HKDF(secret, info, n) = HKDF with SHA-256, a salt of 32 zero bytes, n bytes out
GCM(key, nonce, data, text) = AES-256-GCM, a 12-byte nonce: the ciphertext, then the 16-byte tag
```

A wrap, a link and a sealed field each start with a version byte, `0x01`. A new version byte comes
with new tag strings (`ovis-list-wrap/2` and so on), so no bytes of one version open as another's.

### The keys

- A member's **encryption key** is a P-256 key used for ECDH, written as a key. A device makes it
  in WebCrypto so that it cannot be exported and keeps it in IndexedDB. A PC keeps its private key
  in a file, as the base64url of the 138-byte PKCS8 form a join line's secret has.
- An **epoch key** is 32 random bytes. Epochs count from 0: entry 0 opens epoch 0, and after a
  member is removed an entry opens the next. An entry with a `sealed` field says in clear which
  epoch it is sealed under.
- The **commitment** to an epoch key is
  `SHA-256("ovis-list-epoch-key/1" || id(list) || number(epoch) || key)`, as a hash. The entry that
  opens an epoch carries it in clear, under its signature. A member takes an epoch key, from a
  wrap or from a link, only when it gives the commitment the list holds for that epoch. Without
  this the service, which can wrap any key to any member, could hand a new member a key of its own
  and read what that member seals.
- The commitment to the key of epoch 0 stands in entry 0, whose hash is the list id, so no list id
  can be part of it: there `id(list)` is 32 zero bytes, and the commitment binds its own tag, the
  epoch number 0 and the key. What binds it to its list is entry 0 itself: the list id is the hash
  of the body that carries it. Every later commitment binds the list id too.

### A wrap

An epoch key for one member, made by any member that holds the key. It is stored at the service,
never in the list.

```
wrap   = 0x01 X Y GCM(k, n, no data, epoch key)       113 bytes: 1 + 32 + 32 + 32 + 16
X Y    = the point of a P-256 key made for this wrap alone (the ephemeral key)
k n    = HKDF(shared, "ovis-list-wrap/1" || id(list) || number(epoch) || key(member) || key(ephemeral), 44)
shared = the X of ECDH between the ephemeral key and the member's key, 32 bytes
```

`k` is the first 32 bytes and `n` the last 12. On the wire a wrap is 151 characters of base64url
without padding, in its one spelling. A wrap of another length, with another first byte, or whose
point is not on the curve has not the form.

### A link

Each epoch key also encrypts the one before, so a member given the current key reads every earlier
epoch. The entry that opens epoch e carries the link to epoch e-1 beside its commitment.

```
link = 0x01 nonce GCM(HKDF(key of e, "ovis-list-epoch-link/1", 32), nonce, data, key of e-1)      61 bytes
data = "ovis-list-epoch-link/1" || id(list) || number(e)
```

A member walks back one link at a time and checks each key against its commitment. One walk opens
at most 1024 links; a longer history is walked on from the last key reached. The key the walk
starts from is checked against the commitment of its own epoch too.

### A sealed field

```
sealed    = 0x01 nonce GCM(HKDF(epoch key, "ovis-list-seal/1", 32), nonce, data, plaintext)
data      = "ovis-list-seal/1" || id(list) || number(seq) || number(epoch)
plaintext = "ovis-list-sealed/1" field field ...
```

- `list`, `seq` and the epoch are the entry's own, so a sealed field opens only in the entry it
  was sealed for.
- The plaintext's fields have the form of an entry's fields: lengths of 4 bytes, names ascending.
  A sealed field is the plaintext and 29 bytes, and at most 8192 bytes.
- A writer fills the plaintext up to 256 bytes, or to the next multiple of 256 when it is longer,
  with one more field, `pad`, of zero bytes. So a sealed field is 285 bytes whatever short names
  it holds. `pad` is no name of any kind: no kind writes it, and a reader drops it whatever it
  holds. A reader also reads a plaintext that is not filled.
- A member seals only under a key that gives the commitment the list holds for its epoch, the
  same check as when it took the key.
- The nonce is 12 random bytes. It is never made from `seq`: a member whose entry n lost its place
  signs another entry n, with other fields, and a nonce made from `seq` would come twice under one
  key.
- The bound of one epoch key: among n fields sealed under it, the chance that two nonces are equal
  is under n² / 2^97, and it stays under 2^-32 up to 2^32 fields. Every field sealed counts, also
  for an entry that never got its place. The account service takes at most 16384 entries into one
  list; were each of them sealed under one key, and sealed again a thousand times over, the chance
  would be under 2^-49.
- The epoch key never encrypts by itself: fields and links each use a key of their own made from it.
- An epoch key belongs to one list and one epoch. It is never used for another list or made the
  key of another epoch.

### Who seals, and when

The library sees no list, so these are rules for the member that writes an entry.

- A member seals only under the list's current epoch, and only when the entry that opened that
  epoch comes after the last entry that took a key out of those the epoch key is wrapped to: an
  entry that ends a device's, a PC's or an invite's key (a revoked invite too), or that removes a
  PC by its address. Otherwise it seals nothing and writes its entry without names. Sealed under
  any other key, the names would be read by a member already removed.
- So after a removal nothing is sealed until a member that stays has opened the next epoch. The
  remover places both entries in one request. Where it cannot (a device that signs itself out
  cannot make the key for those that stay), the entries written meanwhile carry no names.
- An epoch that the member being removed opened itself just before its removal does not count: its
  opening entry comes before the removal, and that member holds its key. A member that stays
  opens another.
- What remains: a member from which the service withholds the removal itself does not know of it
  and still seals under the old key, which the removed member holds. Nothing in the list stops a
  service from withholding entries; the harm is bounded to the names written by members that have
  not yet seen the removal.

### A removal, an addition

- After a removal a member that stays makes the next epoch key, puts its commitment and its link
  into the entry that opens the epoch, and gives the service a wrap for every member that stays,
  in the same request. What was sealed before stays readable to the removed member, its own
  removal included; its key and its old wraps open nothing sealed under the new key.
- Every attempt makes a new key. A key whose wraps went out in a request that did not place its
  entry is never used again: by the next attempt the members that stay may be others.
- A member that adds another wraps the current epoch key to it, in the request that places the
  entry. If that entry never gets its place, the key has been wrapped to a key that is no
  member's: the member opens the next epoch before it seals again.
- A member whose encryption key is not a point of the curve gets no wrap; the removal or the
  addition goes on without it.

### What the service still learns

The service reads no name. It does see, of every list:

- which entries carry names and under which epoch, and when each epoch opens;
- the length of each sealed field, which is the length of its plaintext and 29 bytes. Filled, a
  plaintext is 256 bytes unless its names are long: then the service learns in which multiple of
  256 bytes they end;
- the encryption key of every member, which key each wrap of each epoch is for, and so which
  member has no wrap;
- everything an entry says in clear.

### What does not open

Opening never fails with an error. It gives the key or the fields, or one of these, and the device
or PC is then shown without its name:

| why | when |
|---|---|
| `missing` | no wrap, link, key or sealed field was given |
| `form` | a wrong length, another first byte, a point not on the curve, a plaintext that is no fields, a place that is none (a list id with seq 0, none with a later seq) |
| `refused` | in form, but the tag does not hold: another member's wrap, another list, seq or epoch, another key, a changed byte |
| `other_key` | a wrap or a link that opens, to a key that is not the one the list commits to. The name is hidden like any other, and the member also says so: a wrap comes from the account service, so a wrong key in one is a sign of tampering, where the other codes may be a lost or a stale wrap |
| `bound` | the walk back opened as many links as one walk may |
| `unavailable` | the runtime could not do it (no WebCrypto on a page on plain http): a fault of the place, not a verdict on the bytes |

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

### The vectors of seal/

Each file of [`shared/account-list-vectors/seal/`](../shared/account-list-vectors/seal) is one JSON
object with a `name`, an optional `note`, one of `wrap`, `link` and `sealed`, and `expect`.

- `wrap`: `list`, `epoch`, `commitment`, `member` (a name in `keys`, the test keys as above) and
  `text`, the wrap on the wire. A `text` that does not read has not the form.
- `link`: `list`, `from` (`epoch` and its `key`, 64 hex digits), `commitment` (of the epoch before)
  and `bytes` (base64url).
- `sealed`: `list` (empty for entry 0), `seq`, `epoch` (`epoch` and its `key`) and `bytes`.
- `expect` is `{ key }` (the epoch key that comes out, 64 hex digits), `{ fields }` (the names and
  their values, as text, without `pad`) or `{ why }`, one of the codes above.

Wraps, links and sealed fields are made with random bytes, so a vector fixes one to open; nobody is
asked to make the same bytes again. The `-made-elsewhere` vectors were written by a second
implementation, which also reads every vector in the tests with readers of its own (its base64url,
its field form, its key prefix). Devices use WebCrypto with a key that
cannot be exported, so [`scripts/account-list-seal-browser-qa.ts`](../scripts/account-list-seal-browser-qa.ts)
reads every vector in a real browser too.
