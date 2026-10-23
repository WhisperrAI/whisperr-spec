# 11 — Automatic events

Catalogue: [`../conformance/automatic.json`](../conformance/automatic.json)
(`reserved`, `commonProperties`) · SDK rules: [`SPEC.md`](../SPEC.md) → Automatic events

What the server does with the events client SDKs send on their own.

## Why this exists

A churn engine needs an activity signal it can trust. Before this contract an app had activity
only where its developer, or a generated integration, added a `track()` call in the right place.
Generated wiring misses events. The mobile SDKs therefore send reserved events by default:
`app_installed`, `app_updated`, `app_opened`, `app_backgrounded`, `screen_viewed`,
`push_opened`, `push_permission_changed`, (SDK contract v2) `push_received`, and (signals v3)
`app_error` and `app_crashed`. Every app gets "days since last open" on day one, the engine knows
which devices can still receive push, and it can tell a push that never arrived from a push that
arrived and was not opened.

Signals v3 adds `app_error` and `app_crashed`, a `context.session_id` on every client event,
`launch_source` and link attribution on `app_opened`, and per-visit counters on
`app_backgrounded` ([`SPEC.md`](../SPEC.md) → Engagement signals). They let the engine see how
deep each visit went, what brought the user back, and whether the app failed the user before
they left.

## Reserved names are legal without registration

[05](05-registration-revision.md) makes an event code legal only through a committed revision.
Reserved automatic names are the one exception on the `sdk` source profile
([10](10-sdk-compatibility.md)):

| situation | result |
|---|---|
| reserved name, app registry does not list it | accepted, stored as a known (`mapped`) event with `event.code` = the name |
| reserved name, app registered it (any executor) | accepted; the registration supplies label and `payload_schema`; the code keeps its meaning |
| reserved name, app has a derived event with that code (legacy only) | unchanged: rejected as `derived_event_code`, as before |
| bound server producer (`sdk_source_producers`) sends a reserved name | unchanged: needs a committed revision. Server keys do not send device lifecycle events. |

No executor (MCP, PR agent, CLI, wizard) needs to register these names. Registering one is
allowed and harmless. An executor must not add manual `track()` calls for them while the SDK
sends them automatically; that double-counts.

A derived-event definition may never take a reserved name. Reserved names are raw, device-reported
facts.

## Activity

Each reserved event declares `countsAsActivity` in the catalogue.

| counts as activity | does not count |
|---|---|
| `app_opened`, `screen_viewed`, `push_opened` | `app_installed`, `app_updated`, `app_backgrounded`, `push_permission_changed`, `push_received`, `app_error`, `app_crashed` |

"Activity" means the user did something in the app: it drives last-active, active days, and the
lifecycle stages. Events that only describe the app (an install, an update, the app going to the
background) never make a silent user active. This classification is by name. It applies the same
way to a customer's own event with a reserved name.

`push_received` records that a Whisperr push reached the device. A push that arrives is not a use
of the app, so it never makes a user active, also when the app was in the foreground. Only
`push_opened` is the user's action. The engine still excludes `push_opened` from the "returned"
outcome of the message that caused it.

`app_error` and `app_crashed` report that the app failed, not that the user did something. A crash
reported on the next launch arrives with that launch's `app_opened`, which is the activity.

Activity comes only from the app's own events. Provider webhooks, billing events, delivery
receipts, and other source observations never count as activity, whatever their name.

### Commerce activity

The one exception is a store's own shoppers. For an app whose ICP is `dtc_ecom`, the shopper
actions a commerce connector declares with `counts_as_activity` ([02](02-source-connection-manifest.md),
`events`) count as activity once the runtime turns commerce activity on
(`SOURCE_COMMERCE_ACTIVITY_ENABLED`, off by default). Shopify declares `order_paid`,
`order_placed`, `checkout_started` and `checkout_updated`. WooCommerce declares none yet, so its
events never count until its manifest declares them. Shipping, delivery, refunds,
cancellations, customer record changes and history imports never count. Only events written
while the switch is on count; existing rows are never relabelled, and other ICPs and sources are
unaffected.

## Coverage

Reserved events are not part of the app's event universe: they are not instrumentation targets,
so they never change the `wired / applicable` numbers in [08](08-coverage-health.md). The coverage
view lists them separately, with their receipt state (last seen, 30-day count), so the customer
can see that the SDK sends them. A reserved name the app registered itself appears in the
universe as usual and not twice.

## Signals v3 properties

The server stores the v3 properties as sent and does not validate them, as for every reserved
event. `context.session_id` is a free-form context key. Readers that group by session use
`context.session_id`, and `app_backgrounded.session_id` carries the same value. A v3 SDK sends
`launch_source` on every `app_opened`; an `app_opened` without it comes from an older SDK, and
readers treat it as unknown, not as `direct`.

## Invariants

1. A reserved automatic event from a publishable SDK key is accepted and stored as `mapped` for
   an app with an empty registry. (test)
2. A customer registration of a reserved name keeps working unchanged. (test)
3. `app_installed`, `app_updated`, `app_backgrounded`, `push_received`, `app_error`, and
   `app_crashed` never move `last_active_at` or the activity counters; `app_opened` and
   `screen_viewed` do. (test)
4. A derived-event definition with a reserved name fails validation. (test)
5. Reserved events never change the coverage `wired` / `applicable` totals. (test)
