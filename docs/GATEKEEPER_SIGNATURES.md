# Cryptographic Gatekeeper approval authenticity

## Purpose

Gatekeeper approvals are now Ed25519-signed authorization envelopes. The claim ledger will not register or consume an approval unless its signature verifies against a configured issuer/key trust store.

```text
Gatekeeper subject
→ canonical approval envelope
→ Ed25519 signature
→ issuer/key lookup
→ key lifecycle validation
→ signature verification
→ durable authenticity record
→ claim-time re-verification
```

## Signed fields

The signature covers:

- approval ID
- job ID
- plan fingerprint
- component ref
- method
- idempotency key
- policy version
- issued and expiry timestamps
- approval status
- issuer
- key ID
- signature algorithm and version

Unknown extension fields are not copied into the signed envelope.

## Key lifecycle

Each trust-store record declares:

- issuer and key ID
- Ed25519 public key
- `active`, `retired`, or `revoked` status
- signing-validity window
- retirement instant when applicable

An active key may verify approvals issued inside its validity window. A retired key may continue verifying historical approvals issued before retirement. A revoked key is rejected unconditionally, including for approvals already stored but not yet consumed.

This supports overlap during rotation:

```text
old key: retired, historical verification only
new key: active, new approval issuance
```

## Ledger behavior

The claim ledger requires an approval verifier at construction. Registration stores a separate authenticity record containing issuer, key ID, key and signature fingerprints, signature metadata, signature value, and verification time.

Claiming re-verifies the stored signed approval against the current trust store. This means a later key revocation blocks an unconsumed approval.

Legacy approval rows without an authenticity record remain inspectable but cannot authorize a claim.

## Boundary

This slice verifies approval authenticity from a configured trust store. It does not yet distribute trust-store updates, fetch issuer metadata, protect private signing keys, or implement remote Gatekeeper transport. Private keys remain exclusively on the Gatekeeper signing side.
