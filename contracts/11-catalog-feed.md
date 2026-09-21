# Protected catalog snapshot feed (1.0)

A custom backend exposes one HTTPS GET endpoint protected by a dedicated bearer token. Whisperr fetches it on a schedule. This works for a flat shop and a marketplace with venues; customer-specific mappings stay in the customer backend. It requires no Shopify adapter, webhooks, catalog outbox or new integration runner.

The precise shapes are in `schemas/catalog-feed.schema.json`. `conformance/catalog/flat-shop.json` and `hotcard.json` exercise the same contract. Feed pages never contain tenant IDs, users, credentials or raw provider records. Whisperr assigns the tenant, connection and freshness itself. IDs are stable strings within a connection.

## Snapshot protocol

GET the configured URL for page one; subsequent GET requests use the same URL with `cursor=<opaque next_cursor>`. Never accept a next-page URL. Each immutable snapshot has a stable `snapshot_id`, UTC `generated_at`, and `total_items` on every page. Pages contain at most 200 items and 200 issues. Issue-only pages are allowed. `complete` is true exactly when `next_cursor` is null. Snapshot cursors expire; restarting an expired snapshot must not publish a partial catalog.

Whisperr validates every page, duplicate IDs, references, schema, total count, timestamp and configuration/authorization generation before atomically replacing the previous snapshot. Only a fully validated, complete snapshot may remove absent items. A failed or incomplete fetch leaves the previous catalog intact; it still becomes unavailable to messaging at its original freshness deadline. Re-fetching an old snapshot never makes it fresh again. Configuration changes or disconnects fence in-flight refreshes. Refresh leases prevent concurrent workers publishing out of order.

The producer must obtain a consistent database view and persist immutable pages for the duration of pagination. A moving `updated_at` offset query is not a full snapshot. Return minimized issue codes for excluded or unsupported records; do not imply that excluded records were successfully imported. The consumer bounds page count, response bytes, total records, cursors and refresh duration.

## Domain semantics

`location` represents a venue, branch or other physical location. A `parent` reference describes hierarchy only. `product_source` describes a shared source menu only. Neither creates product availability, prices, inherited offers or orderability. A product's `available_at` references list verified venues. `applies_to` links an offer to the product or location it actually concerns. References are connection-local and must resolve within the completed snapshot; cycles are rejected for hierarchical parent references.

Localized names/descriptions are bounded customer-facing facts, never arbitrary metadata. Amounts use integer minor currency units. `meaning` distinguishes list prices, fixed prices, from prices and display-only figures; absence never asserts a discount or personalized payable amount.

`available` means discoverable according to the producer's published catalog. It does not assert stock, opening hours, purchase success or individual redeemability. Structured `buy_x_get_y` terms describe a conditional offer. Membership and runtime redemption rules still apply. The initial integration supports discovery messages; unconditional eligibility or redemption promises require independently verified per-user eligibility. Uncertain semantics must be excluded with an issue or represented as unknown.

A versioned `view_item` action identifies a native product/location/offer/plan/content destination, with an optional owning `location_id`. An offer may deliberately identify its native product. These IDs let customer events refer to catalog items independently of provider-specific feed IDs. They never authorize redemption, payment or order creation.

## Customer integration boundaries

Mobile instrumentation records actual user intent with stable item and location IDs. Canonical Hotcard identity is its numeric backend user ID formatted as a string. Existing login/session saves identify that account for analytics; existing logout paths reset it. Analytics must not change authentication, navigation or ordinary app behavior.

Committed business outcomes belong in the backend, with stable event identity, original occurrence time and durable retries. Viewing an order history screen is not a new order or redemption. Catalog snapshots and outcome events use separate credentials and delivery contracts.

An inbox, native message navigation and push registration are separate integration features. This feed contract does not install them or define message-history endpoints. Any future navigation integration must verify recipient ownership and current target availability before acting on message data.
