# ADR-P08 — Language-neutral wire format: canonical CBOR (closes W-01)
## Status
PROPOSED.
## Context
ADR 0001 pins `term_to_binary [:deterministic, minor_version: 2]` and honestly names its limits: BEAM-specific, atoms-vs-binaries distinct, no cross-runtime guarantee. `path_to_real.md` §1 designates canonical CBOR as the wire format so a JS/AtomVM/Rust peer hashes and verifies identically. This ADR is the migration design; it must not change any behavior's semantics.
## Decision
Ops and delegations encode as **RFC 8949 core-deterministic CBOR, positional arrays** (no maps at the top level): `[version, replica, author, deps_sorted, kind, body, cap]` with a schema registry pinning every `kind`/`body` shape (atoms encode as pinned small-int enum or text — one choice, documented, forever). `id = sha256(cbor)`, url-safe base64 unpadded, as today. Migration is **dual-encode**: for a transition window every op encodes both ways in tests, asserting equal semantic content and stable ids per format; the log stores ids under one format version tag. Golden vectors (bytes + ids) are committed and CI-checked.
## Alternatives considered
Keep term_to_binary + translate at the edge — rejected by §5.2(3): the id must be computable identically by non-BEAM peers, or verification centralizes on BEAM (a coordinator smell). Protobuf/JSON-canonicalization — rejected by boring/reversibility: CBOR-det is the local-first ecosystem's lingua franca (Keyhive/Beelay adjacency) with the smallest schema surface.
## Consequences
Ids change across the format boundary → a Replica is born on exactly one format version; no in-place re-hash of history. Old (POC) logs remain readable under v1 tag. The atoms caveat in ADR 0001 is closed by the schema registry.
## Falsifying test
Golden-vector test: identical bytes+ids from Elixir and from a reference JS encoder for the full op corpus; property (c) re-run under the new encoder; dual-encode equivalence suite green for one full behavior pass.
## Escalation notes
Any change to the positional schema or enum table after first golden vectors = crypto-adjacent → human sign-off.
