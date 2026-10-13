import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-sc-003-taxi-driver-trip.json');

test.describe('SC-003: Taxi Driver End-to-End Voice Channel, Strict FSM Transitions & Negative Suite', () => {

  // Helper function to initialize, load scenario and simulate voice input
  async function setupAppWithScenario(page: any) {
    const appUrl = process.env.APP_URL || 'https://voice-assistant-two-olive.vercel.app';
    await page.goto(appUrl);
    await expect(page.locator('body')).toBeVisible();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(scenarioFilePath);
    await expect(page.locator('body')).toContainText('Taxi Driver End-to-End Trip Workflow');
  }

  // Send voice utterance via Voice Channel / Input
  async function emitVoicePhrase(page: any, phrase: string) {
    const voiceInput = page.locator('[data-testid="voice-input"], input[placeholder*="голос"], input[name="voiceText"]').first();
    if (await voiceInput.isVisible()) {
      await voiceInput.fill(phrase);
      await voiceInput.press('Enter');
    } else {
      // Direct voice dispatch fallback through platform interaction window
      await page.evaluate((text: string) => {
        if ((window as any).__DISPATCH_VOICE_COMMAND__) {
          (window as any).__DISPATCH_VOICE_COMMAND__(text);
        } else {
          window.dispatchEvent(new CustomEvent('voice:command', { detail: { phrase: text } }));
        }
      }, phrase);
    }
  }

  test('WORKFLOW-01: Voice End-to-End Run (ORDER_ACCEPTED -> ARRIVED -> IN_TRIP -> FINISHED -> AVAILABLE)', async ({ page }) => {
    await setupAppWithScenario(page);
    const fsmStatusLocator = page.locator('.driver-status, [data-testid="driver-status"], .badge-status, [data-testid="fsm-status"]').first();

    // 1. Voice Command: «Принять заказ»
    await emitVoicePhrase(page, 'Принять заказ');
    const trace0 = page.locator('.trace-container, [data-testid="execution-trace"]').or(page.locator('text=driver.order.accepted').locator('..')).first();
    await expect(trace0).toBeVisible({ timeout: 5000 });
    await expect(trace0).toContainText('1001');
    await expect(fsmStatusLocator).toHaveText(/ORDER_ACCEPTED|Принят/i);

    // 2. Voice Command: «Я приехал»
    await emitVoicePhrase(page, 'Я приехал');
    const trace1 = page.locator('.trace-container, [data-testid="execution-trace"]').or(page.locator('text=driver.arrived').locator('..')).first();
    await expect(trace1).toBeVisible({ timeout: 5000 });
    await expect(trace1).toContainText('1001');
    await expect(fsmStatusLocator).toHaveText(/DRIVER_ARRIVED|На месте/i);

    // 3. Voice Command: «Начать поездку»
    await emitVoicePhrase(page, 'Начать поездку');
    const trace2 = page.locator('.trace-container, [data-testid="execution-trace"]').or(page.locator('text=driver.trip.started').locator('..')).first();
    await expect(trace2).toBeVisible({ timeout: 5000 });
    await expect(trace2).toContainText('1001');
    await expect(fsmStatusLocator).toHaveText(/IN_TRIP|В пути/i);

    // 4. Voice Command: «Завершить поездку»
    await emitVoicePhrase(page, 'Завершить поездку');
    const trace3 = page.locator('.trace-container, [data-testid="execution-trace"]').or(page.locator('text=driver.trip.finished').locator('..')).first();
    await expect(trace3).toBeVisible({ timeout: 5000 });
    await expect(trace3).toContainText('1001');
    await expect(trace3).toContainText('cash');
    await expect(fsmStatusLocator).toHaveText(/TRIP_FINISHED|Завершена/i);

    // 5. Voice Command: «Готов к следующему заказу»
    await emitVoicePhrase(page, 'Готов к следующему заказу');
    const trace4 = page.locator('.trace-container, [data-testid="execution-trace"]').or(page.locator('text=driver.available').locator('..')).first();
    await expect(trace4).toBeVisible({ timeout: 5000 });
    await expect(trace4).toContainText('available');
    await expect(fsmStatusLocator).toHaveText(/AVAILABLE|Свободен/i);
  });

  test('NEG-01: Voice "Начать поездку" from ORDER_ACCEPTED rejected by FSM', async ({ page }) => {
    await setupAppWithScenario(page);
    const fsmStatusLocator = page.locator('.driver-status, [data-testid="driver-status"], .badge-status, [data-testid="fsm-status"]').first();

    // Move to ORDER_ACCEPTED
    await emitVoicePhrase(page, 'Принять заказ');
    await expect(fsmStatusLocator).toHaveText(/ORDER_ACCEPTED|Принят/i);

    // Illegal voice action
    await emitVoicePhrase(page, 'Начать поездку');

    // FSM rejects illegal transition
    await expect(fsmStatusLocator).toHaveText(/ORDER_ACCEPTED|Принят/i);
    await expect(fsmStatusLocator).not.toHaveText(/IN_TRIP|В пути/i);
  });

  test('NEG-02: Voice "Завершить поездку" from DRIVER_ARRIVED rejected by FSM', async ({ page }) => {
    await setupAppWithScenario(page);
    const fsmStatusLocator = page.locator('.driver-status, [data-testid="driver-status"], .badge-status, [data-testid="fsm-status"]').first();

    // Move to ORDER_ACCEPTED -> DRIVER_ARRIVED
    await emitVoicePhrase(page, 'Принять заказ');
    await emitVoicePhrase(page, 'Я приехал');
    await expect(fsmStatusLocator).toHaveText(/DRIVER_ARRIVED|На месте/i);

    // Illegal voice action
    await emitVoicePhrase(page, 'Завершить поездку');

    // FSM rejects illegal transition
    await expect(fsmStatusLocator).toHaveText(/DRIVER_ARRIVED|На месте/i);
    await expect(fsmStatusLocator).not.toHaveText(/TRIP_FINISHED|Завершена/i);
  });

  test('RECOVERY-01: Voice Recovery preserves FSM state and completes workflow', async ({ page }) => {
    await setupAppWithScenario(page);
    const fsmStatusLocator = page.locator('.driver-status, [data-testid="driver-status"], .badge-status, [data-testid="fsm-status"]').first();

    // 1. Valid: Voice "Принять заказ"
    await emitVoicePhrase(page, 'Принять заказ');
    await expect(fsmStatusLocator).toHaveText(/ORDER_ACCEPTED|Принят/i);

    // 2. Illegal Voice: "Начать поездку" -> Rejected
    await emitVoicePhrase(page, 'Начать поездку');
    await expect(fsmStatusLocator).toHaveText(/ORDER_ACCEPTED|Принят/i);

    // 3. Recovery Voice: "Я приехал" -> Valid transition to DRIVER_ARRIVED
    await emitVoicePhrase(page, 'Я приехал');
    await expect(fsmStatusLocator).toHaveText(/DRIVER_ARRIVED|На месте/i);

    // 4. Valid Next Voice: "Начать поездку" -> Transitions to IN_TRIP
    await emitVoicePhrase(page, 'Начать поездку');
    await expect(fsmStatusLocator).toHaveText(/IN_TRIP|В пути/i);
  });

});
