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

  for (const invalidOrderId of [
    { label: 'blank string', value: '   ' },
    { label: 'null', value: null }
  ]) {
    test(`rejects ${invalidOrderId.label} order IDs without logging an Action or Event`, async ({ page }) => {
      await page.goto(process.env.APP_URL || 'http://localhost:3000');

      const scenarioSet = {
        version: 1,
        id: `map-invalid-${invalidOrderId.label.replace(/\s+/g, '-')}`,
        name: 'Invalid map order selection',
        language: 'en-US',
        scenarios: [{
          id: 'map-invalid-order-selection',
          name: 'Invalid order ID must not dispatch',
          category: 'map',
          difficulty: 'easy',
          trigger: 'driver.order.select',
          steps: [
            { kind: 'emit', event: { type: 'driver.order.selected', payload: { orderId: invalidOrderId.value } } },
            { kind: 'end' }
          ]
        }]
      };

      await page.locator('input[type="file"]').first().setInputFiles({
        name: 'map-invalid-selection.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(scenarioSet))
      });
      await page.evaluate(async () => {
        await (window as any).__SCENARIO_LOAD_PROMISE__;
      });

      await page.getByRole('button', { name: 'Start scenario' }).click();

      const trace = page.locator('[data-testid="execution-trace"]');
      await expect(trace.locator('.trace-entry')).toHaveCount(0);
      await expect(trace).not.toContainText('driver.order.select');
      await expect(trace).not.toContainText('driver.order.selected');

      const terminal = page.locator('[data-testid="execution-terminal"]');
      await expect(terminal).toContainText('SCENARIO_STATE_FAILED');
      await expect(terminal).toContainText('invalid orderId');
      await expect(terminal).not.toContainText('SCENARIO_STATE_COMPLETED');
    });
  }
});
