import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scenarioPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scenarios/map-order-selection.json'
);

test.describe('Map Channel Validation Bench integration', () => {
  test('dispatches map selection through MapChannel and records the selected event in the browser', async ({ page }) => {
    await page.goto(process.env.APP_URL || 'http://localhost:3000');

    await page.locator('input[type="file"]').first().setInputFiles(scenarioPath);
    await page.evaluate(async () => {
      await (window as any).__SCENARIO_LOAD_PROMISE__;
    });

    const loadedSet = await page.evaluate(() => ({
      id: (window as any).__SCENARIO_ENGINE__.getActiveScenarioSetId(),
      scenarioCount: (window as any).__SCENARIO_ENGINE__.getActiveScenarioSet().scenarios.length
    }));
    expect(loadedSet).toEqual({ id: 'map-order-selection', scenarioCount: 1 });

    await page.getByRole('button', { name: 'Start scenario' }).click();

    const trace = page.locator('[data-testid="execution-trace"]');
    await expect(trace).toContainText('driver.order.select');
    await expect(trace).toContainText('driver.order.selected');
    await expect(trace.locator('.trace-entry')).toHaveCount(2);
    await expect(trace).toContainText('"orderId":"00123"');
    await expect(page.locator('[data-testid="execution-terminal"]')).toContainText('SCENARIO_STATE_COMPLETED');
  });
});
