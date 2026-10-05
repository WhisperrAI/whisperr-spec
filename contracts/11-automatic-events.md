# 11 — Automatic events

Catalogue: [`../conformance/automatic.json`](../conformance/automatic.json)
(`reserved`, `commonProperties`) · SDK rules: [`SPEC.md`](../SPEC.md) → Automatic events

What the server does with the events client SDKs send on their own.

## Why this exists

A churn engine needs an activity signal it can trust. Before this contract an app had activity
only where its developer, or a generated integration, added a `track()` call in the right place.
Generated wiring misses events. The mobile SDKs therefore send six reserved events by default:
`app_installed`, `app_updated`, `app_opened`, `app_backgrounded`, `screen_viewed`,
`push_opened`. Every app gets "days since last open" on day one.

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
| `app_opened`, `screen_viewed`, `push_opened` | `app_installed`, `app_updated`, `app_backgrounded` |

"Activity" means the user did something in the app: it drives last-active, active days, and the
lifecycle stages. Events that only describe the app (an install, an update, the app going to the
background) never make a silent user active. This classification is by name. It applies the same
way to a customer's own event with a reserved name.

Activity comes only from the app's own events. Provider webhooks, billing events, delivery
receipts, and other source observations never count as activity, whatever their name.

## Coverage

Reserved events are not part of the app's event universe: they are not instrumentation targets,
so they never change the `wired / applicable` numbers in [08](08-coverage-health.md). The coverage
view lists them separately, with their receipt state (last seen, 30-day count), so the customer
can see that the SDK sends them. A reserved name the app registered itself appears in the
universe as usual and not twice.

## Invariants

1. A reserved automatic event from a publishable SDK key is accepted and stored as `mapped` for
   an app with an empty registry. (test)
2. A customer registration of a reserved name keeps working unchanged. (test)
3. `app_installed`, `app_updated`, and `app_backgrounded` never move `last_active_at` or the
   activity counters; `app_opened` and `screen_viewed` do. (test)
4. A derived-event definition with a reserved name fails validation. (test)
5. Reserved events never change the coverage `wired` / `applicable` totals. (test)
