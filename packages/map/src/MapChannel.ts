import type {
    InteractionAction,
    InteractionContract,
    InteractionEvent,
    Unsubscribe
} from "../../interaction-contract/dist/index"
import {
    DefaultMapMapper,
    MAP_CHANNEL_SOURCE,
    MAP_ORDER_SELECT_ACTION
} from "./MapMapper"
import type { MapMapper } from "./MapMapper"

export interface MapChannelOptions {
    readonly interaction: InteractionContract
    readonly mapper?: MapMapper
    readonly now?: () => string
    readonly createCorrelationId?: () => string
    readonly onAction?: (action: InteractionAction) => void
    readonly onEvent?: (event: InteractionEvent) => void
}

/**
 * Transport adapter for map-originated interaction. It intentionally contains
 * no order/business decisions and does not depend on React, Leaflet or Taxi APIs.
 */
export class MapChannel {
    private readonly options: MapChannelOptions
    private readonly mapper: MapMapper
    private readonly now: () => string
    private readonly createCorrelationId: () => string
    private unsubscribeInteraction: Unsubscribe | null = null

    constructor(options: MapChannelOptions) {
        this.options = options
        this.mapper = options.mapper ?? new DefaultMapMapper()
        this.now = options.now ?? (() => new Date().toISOString())
        this.createCorrelationId = options.createCorrelationId ?? createCorrelationId
    }

    async selectOrder(orderId: unknown): Promise<void> {
        const action = this.mapper.mapOrderSelect(
            orderId,
            this.now(),
            this.createCorrelationId()
        )
        if (!action) return

        this.options.onAction?.(action)
        await this.options.interaction.dispatch(action)
    }

    /** Observe application events without starting or owning the application. */
    startObserving(): void {
        if (this.unsubscribeInteraction) return
        this.unsubscribeInteraction = this.options.interaction.subscribe(event => {
            this.options.onEvent?.(event)
        })
    }

    stopObserving(): void {
        this.unsubscribeInteraction?.()
        this.unsubscribeInteraction = null
    }
}

let correlationSequence = 0
function createCorrelationId(): string {
    correlationSequence += 1
    return `${MAP_CHANNEL_SOURCE}-${Date.now()}-${correlationSequence}`
}

export { MAP_ORDER_SELECT_ACTION }
