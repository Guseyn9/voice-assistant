# Map Channel Migration — Phase 5, slice 4

## Source inspection

The source of truth is `Guseyn9/taxi`, branch `main`. The existing Taxi implementation already has a map interaction boundary in:

- `taxi/src/platform/map-channel/MapChannel.ts`
- `taxi/src/platform/map-channel/MapMapper.ts`
- `taxi/src/platform/map-channel/map-channel-protocol.ts`
- `taxi/src/platform/platform-interface/surfaces/map/MapSurface.ts`

The interaction vocabulary for selecting an order is `driver.order.select` → `driver.order.selected`. The Taxi UI, Leaflet rendering, routing and backend adapters are application-specific and must not be copied into Platform Core.

## Completed coverage

1. The replaceable map-channel boundary lives in `packages/map`, without React, Leaflet or Taxi backend dependencies.
2. Raw order IDs are preserved as non-empty strings or finite numbers, including leading-zero strings and numeric zero.
3. Contract tests cover action shape, observer cleanup, invalid inputs, and raw ID preservation.
4. The Validation Bench runner routes the map-selection fixture through the real `MapChannel`.
5. Browser E2E uploads the fixture and verifies Action/Event entries in the execution trace. The adapter simulates the selected event from the fixture; this is not live Taxi backend integration.
6. Invalid selection contract coverage confirms blank, null, undefined, NaN and infinite IDs dispatch no Action and create no Execution Log entries.

## Remaining migration work

- Inspect the successful CI artifacts and execution report before marking Phase 5 complete.
- Integrate actual map rendering only in a separate application-level change; do not add Leaflet or Taxi backend dependencies to Platform Core.
- A live Taxi UI/backend E2E test remains outside this slice.

## Validation Bench scenario

The uploadable fixture is `scenarios/map-order-selection.json`. It uses ScenarioSet v1 and checks `driver.order.select` → `driver.order.selected` while preserving string order ID `00123`. The browser test exercises the real `MapChannel` through the Validation Bench; the selected event is simulated by the Bench adapter from the fixture.

## Raw order ID compatibility

Taxi's `b_id` can arrive as either a string or a number. The platform mapper accepts finite numbers and non-empty strings, preserving the original type and value. It rejects blank strings, non-finite numbers, `null`, and `undefined`. Do not stringify IDs at the channel boundary; application adapters may perform domain-specific normalization only where explicitly required.
