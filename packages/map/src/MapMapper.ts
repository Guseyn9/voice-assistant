import type { InteractionAction } from "../../interaction-contract/dist/index"

export const MAP_ORDER_SELECT_ACTION = "driver.order.select"
export const MAP_ORDER_SELECTED_EVENT = "driver.order.selected"
export const MAP_CHANNEL_SOURCE = "map"

export interface MapOrderSelectPayload {
    readonly orderId: string
}

export interface MapOrderSelectedPayload {
    readonly orderId: string
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
        if (typeof orderId !== "string" || orderId.trim().length === 0) {
            return null
        }

        return {
            type: MAP_ORDER_SELECT_ACTION,
            payload: { orderId },
            metadata: {
                source: MAP_CHANNEL_SOURCE,
                timestamp,
                correlationId
            }
        }
    }
}
