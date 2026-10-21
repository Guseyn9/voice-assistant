import type { InteractionAction } from "../../interaction-contract/dist/index"

export const MAP_ORDER_SELECT_ACTION = "driver.order.select"
export const MAP_ORDER_SELECTED_EVENT = "driver.order.selected"
export const MAP_CHANNEL_SOURCE = "map"

/** Taxi's raw b_id may be a string or a number; do not normalize it. */
export type MapOrderId = string | number

export interface MapOrderSelectPayload {
    readonly orderId: MapOrderId
}

export interface MapOrderSelectedPayload {
    readonly orderId: MapOrderId
}

export interface MapMapper {
    mapOrderSelect(
        orderId: unknown,
        timestamp: string,
        correlationId: string
    ): InteractionAction<MapOrderSelectPayload> | null
}

/**
 * Pure translation from a map selection into the existing Taxi interaction
 * vocabulary. No UI, backend, state, or browser APIs belong here.
 */
export class DefaultMapMapper implements MapMapper {
    mapOrderSelect(
        orderId: unknown,
        timestamp: string,
        correlationId: string
    ): InteractionAction<MapOrderSelectPayload> | null {
        const validString = typeof orderId === "string" && orderId.trim().length > 0
        const validNumber = typeof orderId === "number" && Number.isFinite(orderId)
        if (!validString && !validNumber) {
            return null
        }

        return {
            type: MAP_ORDER_SELECT_ACTION,
            payload: { orderId: orderId as MapOrderId },
            metadata: {
                source: MAP_CHANNEL_SOURCE,
                timestamp,
                correlationId
            }
        }
    }
}
