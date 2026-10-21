import { expect, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { JsonScenarioProvider } from "../../../packages/scenario-engine/dist/index"

test("map order selection scenario is accepted by the Validation Bench scenario contract", async () => {
    const scenarioPath = resolve(process.cwd(), "scenarios/map-order-selection.json")
    const rawScenario: unknown = JSON.parse(readFileSync(scenarioPath, "utf8"))
    const scenarioSet = await new JsonScenarioProvider(rawScenario).load()

    expect(scenarioSet.id).toBe("map-order-selection")
    expect(scenarioSet.scenarios).toHaveLength(1)
    expect(scenarioSet.scenarios[0].trigger).toBe("driver.order.select")
    expect(scenarioSet.scenarios[0].steps).toEqual([
        {
            kind: "emit",
            event: {
                type: "driver.order.selected",
                payload: { orderId: "00123" }
            }
        },
        { kind: "end" }
    ])
})
