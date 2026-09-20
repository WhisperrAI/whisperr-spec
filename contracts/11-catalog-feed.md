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

A versioned `view_item` action identifies a native product/location/offer/plan/content destination, with an optional owning `location_id`. An offer may deliberately open its native product. It never redeems, pays or creates an order. Before navigating, the customer backend authenticates the user, retrieves the owned message, and verifies the destination is still available.

## Push and durable history

Whisperr sends pushes directly through its existing FCM delivery adapter. Data keys are `whisperr_message_id`, `whisperr_user_id` (the canonical external backend user ID as a string), and `whisperr_action` (JSON-encoded action). A device payload is a navigation hint, not authorization. A logged-in identity mismatch must refuse the action; a cold start must retain the hint until authentication is known and then resolve it through the backend.

Server-only, bound producer credentials can read `GET /v1/users/{external_user_id}/messages?limit=50&cursor=...` returning `{messages:[{id,title,body,created_at,action}],next_cursor}` and `GET /v1/users/{external_user_id}/messages/{message_id}` returning `{message:{...}}`. Public SDK keys cannot access history. The customer backend must derive the external ID from its authenticated user, never from an untrusted recipient parameter. This preserves history when a push is missed.

Hotcard's authenticated proxies are `GET /api/v100/user/whisperr/messages` and `GET /api/v100/user/whisperr/messages/{messageId}/action`; the latter returns `{message_id,action,available}`. Canonical Hotcard identity is its numeric backend user ID formatted as a string. Existing legacy notifications remain distinct.
