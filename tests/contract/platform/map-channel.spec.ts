import { expect, test } from "@playwright/test"
import type {
    InteractionAction,
    InteractionContract,
    InteractionEvent,
    InteractionSnapshot
} from "../../../packages/interaction-contract/dist/index"
import {
    MapChannel,
    MAP_ORDER_SELECT_ACTION,
    MAP_ORDER_SELECTED_EVENT
} from "../../../packages/map/src/index"

class RecordingInteraction implements InteractionContract {
    readonly actions: InteractionAction[] = []
    readonly listeners = new Set<(event: InteractionEvent) => void>()

    async dispatch<TPayload>(action: InteractionAction<TPayload>): Promise<void> {
        this.actions.push(action)
    }

    subscribe(listener: (event: InteractionEvent) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    async snapshot(): Promise<InteractionSnapshot> {
        return { revision: 0, state: {} }
    }

    publish(event: InteractionEvent): void {
        for (const listener of this.listeners) listener(event)
    }
}

test.describe("Map Channel contract", () => {
    test("maps string order selection without normalizing leading zeros", async () => {
        const interaction = new RecordingInteraction()
        const channel = new MapChannel({
            interaction,
            now: () => "2026-10-21T12:00:00.000Z",
            createCorrelationId: () => "map-test-1"
        })

        await channel.selectOrder("00123")

        expect(interaction.actions).toHaveLength(1)
        expect(interaction.actions[0]).toEqual({
            type: MAP_ORDER_SELECT_ACTION,
            payload: { orderId: "00123" },
            metadata: {
                source: "map",
                timestamp: "2026-10-21T12:00:00.000Z",
                correlationId: "map-test-1"
            }
        })
    })

    test("preserves a numeric Taxi order ID as a number", async () => {
        const interaction = new RecordingInteraction()
        const channel = new MapChannel({ interaction })

        await channel.selectOrder(12345)

        expect(interaction.actions).toHaveLength(1)
        expect(interaction.actions[0].payload).toEqual({ orderId: 12345 })
        expect(typeof (interaction.actions[0].payload as { orderId: unknown }).orderId).toBe("number")
    })

    test("accepts numeric zero without treating it as a missing ID", async () => {
        const interaction = new RecordingInteraction()
        const channel = new MapChannel({ interaction })

        await channel.selectOrder(0)

        expect(interaction.actions).toHaveLength(1)
        expect(interaction.actions[0].payload).toEqual({ orderId: 0 })
    })

    test("does not dispatch invalid order IDs", async () => {
        const interaction = new RecordingInteraction()
        const channel = new MapChannel({ interaction })

        await channel.selectOrder("   ")
        await channel.selectOrder(undefined)
        await channel.selectOrder(null)
        await channel.selectOrder(Number.NaN)
        await channel.selectOrder(Number.POSITIVE_INFINITY)

        expect(interaction.actions).toHaveLength(0)
    })

    test("observes application events once and stops observing on cleanup", () => {
        const interaction = new RecordingInteraction()
        const events: InteractionEvent[] = []
        const channel = new MapChannel({
            interaction,
            onEvent: event => events.push(event)
        })

        channel.startObserving()
        channel.startObserving()
        interaction.publish({
            type: MAP_ORDER_SELECTED_EVENT,
            payload: { orderId: "123" },
            metadata: {
                source: "application",
                timestamp: "2026-10-21T12:00:00.000Z"
            }
        })

        expect(events).toHaveLength(1)
        channel.stopObserving()
        interaction.publish({
            type: MAP_ORDER_SELECTED_EVENT,
            payload: { orderId: "123" },
            metadata: {
                source: "application",
                timestamp: "2026-10-21T12:00:01.000Z"
            }
        })
        expect(events).toHaveLength(1)
    })
})
