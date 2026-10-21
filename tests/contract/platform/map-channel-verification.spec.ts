import { expect, test } from "@playwright/test"
import type {
    InteractionAction,
    InteractionContract,
    InteractionEvent,
    InteractionSnapshot
} from "../../../packages/interaction-contract/dist/index"
import { MapChannel, MAP_ORDER_SELECT_ACTION } from "../../../packages/map/src/index"
import { ScenarioEngine, ScenarioRegistry } from "../../../packages/scenario-engine/dist/index"
import { ExecutionLog } from "../../../packages/execution-log/dist/index"
import { VerificationRunner } from "../../../packages/verification/dist/index"

class RecordingInteraction implements InteractionContract {
    readonly actions: InteractionAction[] = []

    async dispatch<TPayload>(action: InteractionAction<TPayload>): Promise<void> {
        this.actions.push(action)
    }

    subscribe(_listener: (event: InteractionEvent) => void): () => void {
        return () => undefined
    }

    async snapshot(): Promise<InteractionSnapshot> {
        return { revision: 0, state: {} }
    }
}

test.describe("Map Channel → Scenario Engine → Verification Harness", () => {
    test("records the map action and verifies the matching selected event", async () => {
        const interaction = new RecordingInteraction()
        const channel = new MapChannel({
            interaction,
            now: () => "2026-10-21T12:00:00.000Z",
            createCorrelationId: () => "map-verification-1"
        })

        await channel.selectOrder("00123")
        expect(interaction.actions).toHaveLength(1)

        const action = interaction.actions[0]
        expect(action.type).toBe(MAP_ORDER_SELECT_ACTION)

        const registry = new ScenarioRegistry()
        registry.register({
            name: "Map order selection",
            trigger: MAP_ORDER_SELECT_ACTION,
            steps: [
                {
                    kind: "emit",
                    event: {
                        type: "driver.order.selected",
                        payload: { orderId: "00123" }
                    }
                },
                { kind: "end" }
            ]
        })

        const log = new ExecutionLog()
        log.append("Action", { type: action.type, payload: action.payload })
        const engine = new ScenarioEngine(registry, { wait: async () => undefined })

        for await (const event of engine.run(action)) {
            log.append("Event", { type: event.type, payload: event.payload })
        }

        const result = new VerificationRunner(log).runOne({
            id: "map-order-selection",
            name: "Map order selection produces selected event",
            expectations: [
                {
                    kind: "Action",
                    payload: { type: "driver.order.select", payload: { orderId: "00123" } }
                },
                {
                    kind: "Event",
                    payload: { type: "driver.order.selected", payload: { orderId: "00123" } }
                }
            ]
        })

        expect(result.passed, result.errors.map(error => error.message).join("; ")).toBe(true)
        expect(log.getEntries()).toHaveLength(2)
    })

    test("fails verification when the selected event is missing", async () => {
        const log = new ExecutionLog()
        log.append("Action", {
            type: "driver.order.select",
            payload: { orderId: "00123" }
        })

        const result = new VerificationRunner(log).runOne({
            id: "map-order-selection-missing-event",
            name: "Map order selection must produce selected event",
            expectations: [
                {
                    kind: "Action",
                    payload: { type: "driver.order.select" }
                },
                {
                    kind: "Event",
                    payload: { type: "driver.order.selected" }
                }
            ]
        })

        expect(result.passed).toBe(false)
        expect(result.errors).toHaveLength(1)
    })

    test("preserves numeric Taxi order IDs through Scenario Engine and Verification Harness", async () => {
        const interaction = new RecordingInteraction()
        const channel = new MapChannel({
            interaction,
            now: () => "2026-10-21T12:00:00.000Z",
            createCorrelationId: () => "map-verification-numeric-1"
        })

        await channel.selectOrder(12345)
        expect(interaction.actions).toHaveLength(1)

        const action = interaction.actions[0]
        expect(action.payload).toEqual({ orderId: 12345 })
        expect(typeof (action.payload as { orderId: unknown }).orderId).toBe("number")

        const registry = new ScenarioRegistry()
        registry.register({
            name: "Numeric map order selection",
            trigger: MAP_ORDER_SELECT_ACTION,
            steps: [
                {
                    kind: "emit",
                    event: {
                        type: "driver.order.selected",
                        payload: { orderId: 12345 }
                    }
                },
                { kind: "end" }
            ]
        })

        const log = new ExecutionLog()
        log.append("Action", { type: action.type, payload: action.payload })
        const engine = new ScenarioEngine(registry, { wait: async () => undefined })

        for await (const event of engine.run(action)) {
            log.append("Event", { type: event.type, payload: event.payload })
        }

        const result = new VerificationRunner(log).runOne({
            id: "map-order-selection-numeric",
            name: "Numeric map order ID is preserved end to end",
            expectations: [
                {
                    kind: "Action",
                    payload: { type: "driver.order.select", payload: { orderId: 12345 } }
                },
                {
                    kind: "Event",
                    payload: { type: "driver.order.selected", payload: { orderId: 12345 } }
                }
            ]
        })

        expect(result.passed, result.errors.map(error => error.message).join("; ")).toBe(true)
        const entries = log.getEntries()
        expect(entries).toHaveLength(2)
        expect(typeof (entries[0].payload as { payload: { orderId: unknown } }).payload.orderId).toBe("number")
        expect(typeof (entries[1].payload as { payload: { orderId: unknown } }).payload.orderId).toBe("number")
    })

})
