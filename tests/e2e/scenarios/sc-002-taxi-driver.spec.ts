import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-sc-002-taxi-driver.json');

test.describe('SC-002: Taxi Driver Standard Trip - Runtime E2E Suite', () => {

  test.beforeEach(async ({ page }) => {
    const appUrl = process.env.APP_URL || 'https://voice-assistant-two-olive.vercel.app';
    await page.goto(appUrl);
    await expect(page.locator('body')).toBeVisible();

    // 1. Switch to External JSON source
    const fileSourceRadio = page.locator('[data-testid="scenario-source-file"]').or(page.getByLabel(/загрузить json|файл json|upload json/i)).or(page.locator('input[type="file"]').locator('..'));
    if (await fileSourceRadio.isVisible()) {
      await fileSourceRadio.click();
    }

    // 2. Upload SC-002 JSON
    const fileInput = page.locator('[data-testid="scenario-file-input"]').or(page.locator('input[type="file"]')).first();
    await fileInput.setInputFiles(scenarioFilePath);

    // 3. Verify filename and ScenarioSet ID in UI
    await expect(page.locator('text=scenario-sc-002-taxi-driver.json').or(page.locator('text=Taxi Driver Standard Trip')).first()).toBeVisible({ timeout: 5000 });
  });

  test('TEST-RUNTIME-01: Operation 1 - voice.accept-order -> driver.order.accepted (orderId: 1001)', async ({ page }) => {
    const startButton = page.getByRole('button', { name: /запустить сценарий|start scenario|выполнить|принять заказ/i }).first();
    await startButton.click();

    const trace = page.locator('[data-testid="step-result-0"]').or(page.locator('text=driver.order.accepted').locator('..')).first();
    await expect(trace).toBeVisible({ timeout: 5000 });
    await expect(trace).toContainText('1001');
    await expect(page.locator('text=/kind:\s*"?end"?|KIND_END_REACHED|завершение|end/i').first()).toBeVisible();
  });

  test('TEST-RUNTIME-02: Operation 2 - voice.arrived -> driver.arrived (orderId: 1001, delay 500ms)', async ({ page }) => {
    const startButton = page.getByRole('button', { name: /запустить сценарий|start scenario|выполнить|я приехал/i }).first();
    await startButton.click();

    const trace = page.locator('[data-testid="step-result-1"]').or(page.locator('text=driver.arrived').locator('..')).first();
    await expect(trace).toBeVisible({ timeout: 5000 });
    await expect(trace).toContainText('1001');
    await expect(page.locator('text=/kind:\s*"?end"?|KIND_END_REACHED|завершение|end/i').first()).toBeVisible();
  });

  test('TEST-RUNTIME-03: Operation 3 - voice.start-trip -> driver.trip.started (orderId: 1001)', async ({ page }) => {
    const startButton = page.getByRole('button', { name: /запустить сценарий|start scenario|выполнить|начать поездку/i }).first();
    await startButton.click();

    const trace = page.locator('[data-testid="step-result-2"]').or(page.locator('text=driver.trip.started').locator('..')).first();
    await expect(trace).toBeVisible({ timeout: 5000 });
    await expect(trace).toContainText('1001');
    await expect(page.locator('text=/kind:\s*"?end"?|KIND_END_REACHED|завершение|end/i').first()).toBeVisible();
  });

  test('TEST-RUNTIME-04: Operation 4 - voice.finish-trip -> driver.trip.finished (orderId: 1001, cash, delay 300ms)', async ({ page }) => {
    const startButton = page.getByRole('button', { name: /запустить сценарий|start scenario|выполнить|завершить поездку/i }).first();
    await startButton.click();

    const trace = page.locator('[data-testid="step-result-3"]').or(page.locator('text=driver.trip.finished').locator('..')).first();
    await expect(trace).toBeVisible({ timeout: 5000 });
    await expect(trace).toContainText('1001');
    await expect(trace).toContainText('cash');
    await expect(page.locator('text=/kind:\s*"?end"?|KIND_END_REACHED|завершение|end/i').first()).toBeVisible();
  });

  test('TEST-RUNTIME-05: Operation 5 - voice.available -> driver.available (driverStatus: available)', async ({ page }) => {
    const startButton = page.getByRole('button', { name: /запустить сценарий|start scenario|выполнить|готов/i }).first();
    await startButton.click();

    const trace = page.locator('[data-testid="step-result-4"]').or(page.locator('text=driver.available').locator('..')).first();
    await expect(trace).toBeVisible({ timeout: 5000 });
    await expect(trace).toContainText('available');
    await expect(page.locator('text=/kind:\s*"?end"?|KIND_END_REACHED|завершение|end/i').first()).toBeVisible();
  });

});
