# 06 — Catalog and offer projection

Schema: [`../schemas/catalog.schema.json`](../schemas/catalog.schema.json)

What may be offered to a person, and how freshness gates it. The governing rule: **Whisperr must
never offer something that does not exist, is unavailable, or was invented.**

## Shape — the minimized offerable projection

```json
{
  "source_item_id": "gid://shopify/Product/8471",
  "connection_id": "con_5Hj…",
  "type": "product",
  "name": "Trail Runner GTX",
  "url": "https://shop.example.com/products/trail-runner-gtx",
  "availability": "available",
  "price": { "amount_minor": 12900, "currency": "EUR" },
  "category": "footwear",
  "location": "EU",
  "approved_fields": { "size_range": "38-46" },
  "fresh_as_of": "2026-08-31T09:05:00.000Z",
  "source_version": "8471:v12"
}
```

`type`: `product` · `plan` · `content` · `location` · `offer`
`availability`: `available` · `limited` · `unavailable` · `unknown`

`approved_fields` is an explicit per-app allowlist. Nothing else from the source item is stored —
this is the same minimization boundary as [03](03-identity-authority.md), applied to catalog.

## Freshness

Each connector declares a freshness threshold in its manifest. Past the threshold, `availability`
becomes `unknown` **automatically** — staleness is not a separate flag anyone has to remember to
check; it collapses into the availability value that the candidate filter already reads.

`unknown` is never offerable.

## The offer flow

```text
allowed offer types (from the intervention plan)
   ↓
query the fresh catalog
   ↓
apply constraints — availability, location, inventory, price, policy
   ↓
deterministic small candidate set          ← this is the whole safety mechanism
   ↓
ONLY those candidates reach generation
   ↓
validate every reference in the output against the candidate set
   ↓
suppress the offer when uncertain
```

Two rules make this hold:

1. **Generation cannot see what it cannot offer.** The candidate set is the complete universe of
   items the generator receives. It cannot name an item outside it, because it was never given
   one. This extends the existing generation boundary
   (`whisperr-go/internal/engine/messagegen/assemble.go:18`, which already excludes raw event rows
   and raw traits) rather than bypassing it.
2. **Post-generation reference validation.** Every item reference in generated output is checked
   back against the candidate set. A reference to anything else means the model invented it, and
   the offer is suppressed.

Candidate selection is **deterministic** for identical inputs — same catalog state, same user
state, same plan produces the same candidate set. Non-determinism here would make the whole chain
unauditable.

## History ranks, it never proves

Historical events may influence *relevance* — what this person is likely to care about. They may
never establish *current availability*. A user who bought a product every month for a year gets no
offer for it when today's catalog says `unavailable`.

## Suppression is narrow

Catalog uncertainty suppresses **the offer**, not the message and not all messaging. An
intervention that can say something useful without naming an item still sends; it simply sends
without the offer.

## Invariants

1. Generated output cannot reference an item outside the candidate set. (negative test)
2. A catalog past its freshness threshold yields `unknown` and offers nothing.
3. `unavailable` and `unknown` items are never candidates, whatever history suggests.
4. Candidate selection is deterministic for identical inputs.
5. Raw event rows and raw traits remain excluded from generation context.
6. Catalog uncertainty suppresses offers only — never all messaging.
