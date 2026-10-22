# Map Channel Migration — Phase 5, slice 3

## Source inspection

The source of truth is `Guseyn9/taxi`, branch `main`. The existing Taxi implementation already has a map interaction boundary in:

- `taxi/src/platform/map-channel/MapChannel.ts`
- `taxi/src/platform/map-channel/MapMapper.ts`
- `taxi/src/platform/map-channel/map-channel-protocol.ts`
- `taxi/src/platform/platform-interface/surfaces/map/MapSurface.ts`

The interaction vocabulary for selecting an order is `driver.order.select` → `driver.order.selected`. The Taxi UI, Leaflet rendering, routing and backend adapters are application-specific and must not be copied into Platform Core.

## Scope of this slice

This change ports only the replaceable map-channel boundary into `packages/map`:

1. A pure mapper translates an order selection to an InteractionAction.
2. The channel dispatches through the existing InteractionContract and exposes event observation.
3. Invalid order IDs are ignored by the mapper.
4. Contract tests cover action shape, raw ID preservation, invalid input, and observer cleanup.

No existing Platform Core package or Voice Channel implementation is changed.

## Current status and remaining migration work

- The Validation Bench scenario runner now routes the map-selection fixture through the real `MapChannel`, rather than treating `driver.order.select` as if it were already a domain event.
- A browser E2E test uploads the fixture, starts it through the UI, and verifies both the dispatched Action and the matching selected Event in the execution trace.
- The Validation Bench adapter simulates the application's response using the selected event declared in the fixture. This proves channel-to-contract wiring in the browser, but is not a live Taxi backend or production UI integration.
- Continue with negative browser coverage for invalid order IDs and inspect the CI artifacts before marking Phase 5 complete.
- Integrate actual map rendering only in a separate application-level change; do not add Leaflet or Taxi backend dependencies to Platform Core.


## Validation Bench scenario

The uploadable scenario fixture is `scenarios/map-order-selection.json`. In the Voice Demo Validation Bench, choose the JSON-file scenario source and upload this file. It uses the existing ScenarioSet v1 contract and checks the `driver.order.select` → `driver.order.selected` vocabulary while preserving the string order ID `00123`. The contract test loads the fixture through `JsonScenarioProvider`, the same validator used for uploaded scenario files.

The browser E2E test additionally exercises the real `MapChannel` through the Validation Bench. The selected event is simulated by the Bench adapter from the fixture; this does not replace a live Taxi UI/backend end-to-end test.


## Raw order ID compatibility

Taxi's `b_id` can arrive as either a string or a number. The platform mapper therefore accepts finite numbers and non-empty strings, preserving the original type and value (including string leading zeros and numeric zero). It rejects blank strings, non-finite numbers, `null`, and `undefined`. Do not stringify IDs at the channel boundary; application adapters may perform domain-specific normalization only where explicitly required.
