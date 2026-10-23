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

---

## v2 — typed facts, push, feed 1.1, Google Merchant (catalog-v2/1)

Schemas: [`../schemas/catalog-item-v2.schema.json`](../schemas/catalog-item-v2.schema.json) (the item),
[`../schemas/catalog-push.schema.json`](../schemas/catalog-push.schema.json) (the push API).
Server SDK conformance: [`../conformance/catalog_push.json`](../conformance/catalog_push.json).

v2 keeps everything above. The stored projection is still the minimized offerable item, and
generation still sees only the candidate set. v2 adds typed facts that make better candidates,
two more ways in (push and Google Merchant feeds), and a change log. All of it stays
**below** the generation boundary: the writer gets at most three product facts (title, prices,
type, brand, one collection name), never URLs, images or ids. Code renders links and cards.

### The v2 item

One shape, `CatalogItemInput`, serves the push API and feed `schema_version "1.1"`. It is the
rc3 feed item plus these optional keys:

| Key | Meaning |
|---|---|
| `kind` | `product` · `content` · `course` · `plan` · `location` · `offer`. Defaults to `type`; `course` needs `type: content`, every other kind equals `type`. |
| `image_url` | Main image, https on port 443, any CDN host. Never image bytes. |
| `compare_at_minor` | Regular price when on sale. |
| `price_min_minor`, `price_max_minor` | Range over all sellable variants, ignoring stock. Always together. |
| `currency` | Needed when `price` is absent and any `*_minor` is set; otherwise equal to `price.currency`. |
| `any_variant_in_stock` | |
| `product_type` (≤255), `brand` (≤128) | |
| `collections[]` | ≤32 of `{id, name, handle?, url?}`. A collection `url` that fails the URL policy is dropped; the collection is kept. |
| `tags[]` | ≤32, each ≤64 characters. Trimmed and deduplicated case-insensitively. |
| `extras{}` | Only `size`, `color`, `material`, `pattern`, `gender`, `age_group`, `condition`, `google_product_category`, `unit`, `flavor`, `scent`; string values ≤64 characters; ≤512 bytes in total. Breaking a rule drops the whole object (issue `invalid_extras`), not the item. |
| `published_at` | RFC 3339 UTC. |
| `gift_card` | Gift cards are never named as products. |
| `variants[]` | ≤100 of `{variant_id, title?, availability, price_minor?, compare_at_minor?}`. Stored only for variants a flow watches. |

Rules:

- Required: `source_item_id` (≤512), `type`, `name`, `availability`. Push also requires
  `updated_at`, RFC 3339 in UTC (`Z`); a feed item may omit it (the page's `generated_at` is used).
- Forbidden: `connection_id`, `fresh_as_of`, `approved_fields`. The server sets them.
- `source_item_id` is stable and is the same value as `product_id` in the app's tracked events.
  It becomes the item's `external_id`.
- Prices are integers in minor units (ISO 4217 exponents: USD 2, JPY 0, KWD 3).
- No descriptions. The `price` is the lowest current price among available variants.

### Ordering, idempotency, freshness

- Writes are ordered by `updated_at` (deletes by `deleted_at`). An older write is answered
  `ignored_older` and changes nothing, so a retried or reordered request can never apply twice
  or overwrite a newer one.
- Equal content at an equal or newer `updated_at` is `unchanged`: only freshness moves, and no
  change rows are written. Different content at the same `updated_at` is `revision_conflict`.
- `fresh_as_of` is the receive time. Past the source's freshness threshold (push default
  7200 s) availability collapses to `unknown`, as for every catalog.

### Push API (server key only)

Base `https://api.whisperr.net`, header `X-API-Key: wrk_…`. A publishable key (`wpk_…`) is
refused with 403 `server_key_required`; server SDKs refuse it locally before sending anything.
While a deployment has the push API off every route answers 404 `route_not_implemented`, so
clients can feature-detect it.

| Route | Request | Answer |
|---|---|---|
| `POST /v1/catalog/items/batch` | `{"items":[item…]}`, ≤500 items, ≤2 MiB | `{"accepted","applied","unchanged","ignored_older","rejected":[{"index","source_item_id","code","message"}]}` |
| `POST /v1/catalog/items/delete` | `{"items":[{"source_item_id","deleted_at"}]}`, ≤1000 | `{"deleted","ignored_older","not_found","rejected":[…]}` |
| `POST /v1/catalog/snapshots` | `{}` | `{"snapshot_id","started_at"}`. Opening a snapshot supersedes an open one. |
| `POST /v1/catalog/snapshots/{snapshot_id}/complete` | `{"item_count":N}` | Tombstones live pushed items not written since `started_at`. `{"tombstoned","item_count","state":"ready"}` |
| `POST /v1/catalog/heartbeat` | `{"item_count":N}` | N equal to the live count: every live item is re-dated, `{"refreshed":true}`. Otherwise nothing is re-dated: `{"refreshed":false,"reason":"count_mismatch","stored_count":M}`. |
| `GET /v1/catalog/status` | | The `custom_code` source's health (`SourceHealth`). |

A full sync is: open a snapshot, upsert every item, complete it with the count. Between full
syncs, a heartbeat every 30 minutes with the item count keeps the catalog fresh without
resending it. **A heartbeat is refused with 409 `snapshot_open` while a snapshot is open**:
complete it (or open a new one, which supersedes it) first.

Per-item reject codes (`rejected[].code`); one rejected item never fails the rest:

| Code | When |
|---|---|
| `invalid_item` | Does not match the item schema (also a delete with a future `deleted_at`). |
| `missing_field` | A required key is absent or null. |
| `invalid_url` | `url` is neither https nor an approved deep link. |
| `url_host_not_allowed` | `url` host is outside the source's allowed hosts (the host is shown on the health card). |
| `invalid_image_url` | `image_url` is not https on port 443. |
| `invalid_price` | A negative or non-integer price, or a price range with one bound. |
| `invalid_currency` | Not an ISO 4217 code, or not equal to `price.currency`. |
| `invalid_kind` | `kind` does not fit `type`. |
| `revision_conflict` | Different content at the same `updated_at`. Send a newer `updated_at`. |

**Client-side only:** `item_too_large`. The server never sends it. A server SDK adds it to
`rejected[]` itself for an item that alone encodes to more than the 2 MiB body limit, or that
still gets 413 when sent alone (see 413 below). Its `message` is SDK-defined. The fixture lists
it apart, in `reject_codes.client`.

Request-level errors always have the body `{"error":{"code","message"}}`:

| Status | Code | Retry |
|---|---|---|
| 400 | `invalid_request` | no |
| 401 | `missing_api_key`, `invalid_api_key` | no |
| 403 | `server_key_required` | no |
| 404 | `route_not_implemented` (push API off) | no |
| 409 | `catalog_push_disabled` (the owner turned push off), `catalog_source_unavailable` (the custom code source is disconnected), `snapshot_not_open`, `snapshot_open` | no |
| 413 | `batch_too_large` | never resent unchanged. An upsert chunk is split in halves and resent; a single item that still gets 413 becomes `item_too_large`. A delete raises it. |
| 429, 5xx | `rate_limited`, … | yes, with backoff, honoring `Retry-After`, resending the same body |

### Server SDK client

Every server SDK exposes `upsert`, `delete`, `beginSnapshot`, `completeSnapshot`, `heartbeat`,
`status` (named per language) and `toMinorUnits(amount, currency)`. It uses a server key only,
calls synchronously (not queued), chunks at 500 upserts / 1000 deletes / 2 MiB, maps reject
indexes back to the caller's list, sums chunk results, retries only 429 and 5xx, and refuses a
snapshot id outside `^[A-Za-z0-9_-]{1,64}$` locally. `conformance/catalog_push.json` pins all of
it; each SDK bundles a byte-identical copy.

### Feed 1.1 and Google Merchant

- A JSON pull feed with `schema_version "1.1"` uses the 1.0 page envelope
  (`schema_version`, `snapshot_id`, `generated_at`, `total_items`, `items` ≤200, `complete`,
  `next_cursor`, `issues`; `?cursor=` for the next page) with v2 items
  (`catalog-item-v2.schema.json#/$defs/feed_page`). 1.0 stays strict and unchanged.
- A feed's format is `whisperr_json`, `google_merchant_xml`, `google_merchant_tsv` or `auto`
  (`{` → JSON, `<` → XML, else TSV). The bearer token is optional for Google Merchant feeds.
- A Google Merchant document is one fetch (≤128 MiB, ≤100 000 rows). RSS 2.0 `<item>` or Atom
  `<entry>` with the `g:` namespace `http://base.google.com/ns/1.0`, or TSV with a header row
  of attribute names without `g:`.
- Mapping. Rows group by `item_group_id`, else one item per `id`:
  - `source_item_id` = `item_group_id`, else `id`; a variant's `variant_id` = `id`.
  - `name` is the most common title in the group (tie: shortest, then first). `url` = `link`
    and `image_url` = `image_link` of the first row.
  - `price "15.00 USD"` → minor units. A `sale_price` counts when it has no
    `sale_price_effective_date`, or the window contains the fetch time; then the sale price is
    the price and `price` is `compare_at`.
  - `in_stock` → `available`, `out_of_stock` → `unavailable`, `preorder`/`backorder` → `limited`.
    The item is in stock when any variant is; `price_minor` is the lowest in-stock effective
    price; `price_min`/`price_max` cover all variants.
  - `product_type` → `product_type`, and one collection
    `{"id":"gmc:product_type:"+lower(path), "name": last " > " segment}`. `brand` → `brand`.
    `custom_label_0..4` → `tags`. `color`, `size`, `material`, `pattern`, `gender`,
    `age_group`, `condition`, `google_product_category` → `extras`.
  - Ignored: `description`, `additional_image_link`, `shipping`, `tax`, `gtin`, `mpn`, `mobile_link`.
- An invalid row is excluded with an issue (`invalid_item`, `missing_price`, `invalid_url`,
  `url_host_not_allowed`, `invalid_availability`; at most 200 listed), and the source is
  `ready_with_exclusions`. Only document-level failures fail a run.

### Connectors

- **Shopify** fills the same facts from the Admin API (collections with their own webhooks).
  The optional scope `unauthenticated_read_product_listings` turns on a **live check** at send
  time through the Storefront API. A live check can only narrow an offer: `availableForSale`
  false suppresses the item for that send, a live price or URL replaces the stored one for that
  send, and a null node (not published to the token's channel), a timeout or an error is no
  live answer, so the stored copy is used.
- **WooCommerce** plugin 1.1.0 adds the facts to `woocommerce_update_product` and fires
  `whisperr/catalog_term` for product categories. Older plugins send no facts; their products
  stay unclassified and are never named.

### Classification gate

Every product is classified once per content change (`ok`, `sensitive` with a class, `junk`) by a
deterministic keyword floor first and then a daily store-batch model call that can only add
restrictions. **A product that is not `ok` is never a candidate**, and an unclassified one is
never named. Other kinds are not gated.

### v2 invariants

7. An older `updated_at` / `deleted_at` never overwrites a newer write; a retry never applies twice.
8. A heartbeat whose count differs from the live count re-dates nothing, and none is accepted while a snapshot is open.
9. A live check never widens an offer: no live answer means the stored copy, never "unavailable" and never "available".
10. Unclassified, sensitive and junk products are never candidates.
11. URLs, images and ids never reach generation; at most three product facts do.
