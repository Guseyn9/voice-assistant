import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-sc-004-taxi-driver-dialogue.json');

test.describe('E2E: SC-004 Taxi Driver Multi-Turn Dialogue & Real FSM Suite (ТЗ-VOICE-SC-004)', () => {

  async function setupApp(page: any) {
    const appUrl = process.env.APP_URL || 'https://voice-assistant-two-olive.vercel.app';
    await page.goto(appUrl);
    await expect(page.locator('body')).toBeVisible();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(scenarioFilePath);
    await expect(page.locator('body')).toContainText('Taxi Driver Multi-Turn Dialogue');
  }

  async function emitVoicePhrase(page: any, phrase: string) {
    await page.evaluate(async (text: string) => {
      const channel = (window as any).__VOICE_CHANNEL__;
      if (!channel) {
        throw new Error('VoiceChannel production instance is not initialized on window.__VOICE_CHANNEL__');
      }
      return channel.handleIncomingVoice(text);
    }, phrase);
  }

  test('DIALOGUE-E2E-01: Incomplete Voice "Прими заказ" -> WAITING_FOR_SLOT & Prompt "Какой заказ?"', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Прими заказ');

    const state = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm ? dm.getActiveState() : null;
    });

    expect(state).not.toBeNull();
    expect(state.status).toBe('WAITING_FOR_SLOT');
    expect(state.intent).toBe('ACCEPT_ORDER');
    expect(state.missingSlots).toEqual(['orderId']);
    expect(state.clarificationPrompt).toBe('Какой заказ?');
  });

  test('DIALOGUE-E2E-02: Slot filling "Заказ 1001" -> driver.order.accepted -> Real FSM: ORDER_ACCEPTED', async ({ page }) => {
    await setupApp(page);

    const fsmLocator = page.locator('[data-testid="fsm-driver-state"], .driver-status, [data-testid="driver-status"]').first();

    // 1. Incomplete Command
    await emitVoicePhrase(page, 'Прими заказ');

    // 2. Complete with Slot
    await emitVoicePhrase(page, 'Заказ 1001');

    // 3. Dialogue State COMPLETED
    const state = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm ? dm.getActiveState() : null;
    });
    expect(state.status).toBe('COMPLETED');
    expect(state.slots).toEqual({ orderId: 1001 });

    // 4. Validate Action executed in logs
    const action = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const logs = dm ? dm.getExecutionLogs() : [];
      return logs.find((l: any) => l.intent === 'ACCEPT_ORDER');
    });
    expect(action).toBeDefined();
    expect(action.payload).toEqual({ orderId: 1001 });

    // 5. Validate Real Driver FSM State transitioned to ORDER_ACCEPTED
    await expect(fsmLocator).toHaveText(/ORDER_ACCEPTED|Принят/i);
  });

  test('NEG-02: Invalid response "Не знаю" preserves Dialogue State context', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, 'Не знаю');

    const state = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm ? dm.getActiveState() : null;
    });

    expect(state.status).toBe('WAITING_FOR_SLOT');
    expect(state.missingSlots).toEqual(['orderId']);

    const action = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const logs = dm ? dm.getExecutionLogs() : [];
      return logs.find((l: any) => l.intent === 'ACCEPT_ORDER');
    });
    expect(action).toBeUndefined();
  });

  test('NEG-03: Cancellation "Отмена" terminates Dialogue State cleanly without FSM transition', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, 'Отмена');

    const state = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm ? dm.getActiveState() : null;
    });

    expect(state.status).toBe('CANCELLED');

    await emitVoicePhrase(page, '1001');

    const hasExecuted = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const logs = dm ? dm.getExecutionLogs() : [];
      return logs.some((l: any) => l.intent === 'ACCEPT_ORDER');
    });
    expect(hasExecuted).toBe(false);
  });

  test('NEG-04: Independent command "Я приехал" resets active ACCEPT_ORDER dialogue', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Прими заказ');
    
    await emitVoicePhrase(page, 'Я приехал');

    const state = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm ? dm.getActiveState() : null;
    });

    expect(state.intent).toBe('DRIVER_ARRIVED');
  });

  test('RECOVERY-01: Full recovery cycle from invalid response to valid order completion', async ({ page }) => {
    await setupApp(page);
    const fsmLocator = page.locator('[data-testid="fsm-driver-state"], .driver-status, [data-testid="driver-status"]').first();

    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, 'Не знаю');
    await emitVoicePhrase(page, '1001');

    await expect(fsmLocator).toHaveText(/ORDER_ACCEPTED|Принят/i);
  });

  test('E2E-IDEMP-01: Strict idempotency - duplicate utterance results in exactly 1 execution', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, '1001');
    
    await emitVoicePhrase(page, '1001');

    const executionCount = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const logs = dm ? dm.getExecutionLogs() : [];
      return logs.filter((l: any) => l.intent === 'ACCEPT_ORDER').length;
    });

    expect(executionCount).toBe(1);
  });

});
