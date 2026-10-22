import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "@playwright/test"
import { runAll, readJsonReport, dismissNextDialog, countActionLogEntries } from "./utils/helpers"

/**
 * PR-11: External JSON Scenarios.
 *
 * Covers: Built-in loads by default and is used by Run All; a valid
 * user-supplied JSON scenario file can be loaded and is used by Run
 * All instead, with the report recording ScenarioSource/ScenarioId/
 * ScenarioFile; and invalid files (bad JSON, and JSON that fails the
 * ScenarioSet contract) are rejected with a visible error, without
 * disturbing the currently active (working) scenario set.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, "fixtures")

test.describe("PR-11: External JSON Scenarios", () => {

    test("1. Built-in is the default source and is what Run All executes", async ({ page }) => {
        await page.goto("/")
        await expect(page.getByTestId("scenario-source-builtin")).toBeChecked()
        await expect(page.getByTestId("scenario-file-name")).toHaveText("builtin.json")

        await runAll(page)
        const report = await readJsonReport(page)
        expect(report.TestConfiguration).toBeTruthy()
        expect(report.ScenarioSource).toBe("builtin")
        expect(report.ScenarioId).toBe("driver-standard-trip")
    })

    test("2. a valid JSON scenario file replaces the active scenario set and is used by Run All", async ({ page }) => {
        await page.goto("/")

        await page.getByTestId("scenario-source-file").check()
        await page.setInputFiles('[data-testid="scenario-file-input"]', path.join(FIXTURES, "custom-scenario-upload.json"))

        await expect(page.getByTestId("scenario-file-name")).toHaveText("custom-scenario-upload.json")
        await expect(page.getByTestId("scenario-error")).toBeHidden()

        await runAll(page)

        const report = await readJsonReport(page)
        expect(report.ScenarioSource).toBe("file")
        expect(report.ScenarioId).toBe("custom-scenario-upload")
        expect(report.ScenarioFile).toBe("custom-scenario-upload.json")

        // The uploaded file has exactly 2 scenarios, not the builtin 5.
        expect(report.Summary.totalScenarios).toBe(2)

        const actionCount = await countActionLogEntries(page)
        expect(actionCount).toBe(2)

        const log = await page.getByTestId("execution-log").innerText()
        expect(log).toContain("voice.accept-order")
        expect(log).toContain("voice.finish-trip")
    })

    test("3. malformed JSON is rejected with an error and Built-in stays active", async ({ page }) => {
        await page.goto("/")

        await page.getByTestId("scenario-source-file").check()
        const dialogPromise = dismissNextDialog(page)
        await page.setInputFiles('[data-testid="scenario-file-input"]', path.join(FIXTURES, "invalid-not-json.json"))

        expect(await dialogPromise).toBe("alert")
        await expect(page.getByTestId("scenario-source-builtin")).toBeChecked()
        await expect(page.getByTestId("scenario-file-name")).toHaveText("builtin.json")

        // Run All must still work — against the untouched builtin set.
        await runAll(page)
        const report = await readJsonReport(page)
        expect(report.ScenarioSource).toBe("builtin")
    })

    test("4. JSON that fails the ScenarioSet contract (no scenarios) is rejected and Built-in stays active", async ({ page }) => {
        await page.goto("/")

        await page.getByTestId("scenario-source-file").check()
        const dialogPromise = dismissNextDialog(page)
        await page.setInputFiles('[data-testid="scenario-file-input"]', path.join(FIXTURES, "invalid-missing-scenarios.json"))

        expect(await dialogPromise).toBe("alert")
        await expect(page.getByTestId("scenario-source-builtin")).toBeChecked()
        await expect(page.getByTestId("scenario-error")).toBeVisible()

        await runAll(page)
        const report = await readJsonReport(page)
        expect(report.ScenarioSource).toBe("builtin")
        expect(report.Summary.totalScenarios).toBe(5)
    })

    test("5. Automatic and Interactive both reflect a switched scenario file", async ({ page }) => {
        await page.goto("/")

        await page.getByTestId("scenario-source-file").check()
        await page.setInputFiles('[data-testid="scenario-file-input"]', path.join(FIXTURES, "custom-scenario-upload.json"))
        await expect(page.getByTestId("scenario-file-name")).toHaveText("custom-scenario-upload.json")

        await page.getByTestId("validation-mode").selectOption("interactive")
        await page.getByTestId("input-source").selectOption("inject")

        // The inject-select dropdown should offer the custom triggers.
        const options = await page.getByTestId("inject-action").locator("option").allTextContents()
        expect(options).toEqual(["voice.accept-order", "voice.finish-trip"])
    })


    test("map channel fixture loads in the browser and exposes its trigger to Interactive Inject Action", async ({ page }) => {
        await page.goto("/")

        await page.getByTestId("scenario-source-file").check()
        await page.setInputFiles(
            '[data-testid="scenario-file-input"]',
            path.resolve(process.cwd(), "scenarios/map-order-selection.json")
        )

        await expect(page.getByTestId("scenario-file-name")).toHaveText("map-order-selection.json")
        await expect(page.getByTestId("scenario-error")).toBeHidden()

        await page.getByTestId("validation-mode").selectOption("interactive")
        await page.getByTestId("input-source").selectOption("inject")

        const options = await page.getByTestId("inject-action").locator("option").allTextContents()
        expect(options).toEqual(["driver.order.select"])
    })

})
