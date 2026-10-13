import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-sc-007-taxi-driver-context-isolation.json');

test.describe('E2E: SC-007 Context Isolation & Cross-Contamination Protection Suite (ТЗ-VOICE-SC-007)', () => {

  async function setupApp(page: any) {
    const appUrl = process.env.APP_URL || 'https://voice-assistant-two-olive.vercel.app';
    await page.goto(appUrl);
    await expect(page.locator('body')).toBeVisible();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(scenarioFilePath);
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

  test('CONTEXT-01: Incomplete First Order (1001) does NOT trigger execution', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, '1001');

    const state = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getActiveState());
    expect(state.status).toBe('WAITING_FOR_SLOT');
    expect(state.intent).toBe('ACCEPT_ORDER');
    expect(state.slots.orderId).toBe(1001);
    expect(state.missingSlots).toEqual(['payment']);

    const matching1001 = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.intent === 'ACCEPT_ORDER' && l.payload?.orderId === 1001);
    });
    expect(matching1001.length).toBe(0);
  });

  test('CONTEXT-02 & CONTEXT-03: Switching to Order 1002 executes strictly 1002 with zero 1001 contamination', async ({ page }) => {
    await setupApp(page);
    const fsmLocator = page.locator('[data-testid="fsm-driver-state"], .driver-status, [data-testid="driver-status"]').first();

    // 1. Start order 1001
    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, '1001');

    // 2. Switch to order 1002 without completing 1001
    await emitVoicePhrase(page, 'Прими заказ 1002');
    let state = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getActiveState());
    expect(state.status).toBe('WAITING_FOR_SLOT');
    expect(state.slots.orderId).toBe(1002);
    expect(state.missingSlots).toEqual(['payment']);

    // 3. Fill payment for order 1002
    await emitVoicePhrase(page, 'Картой');
    state = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getActiveState());
    expect(state.status).toBe('COMPLETED');
    expect(state.slots).toEqual({ orderId: 1002, payment: 'card' });

    // Validate strictly 1 execution for 1002 + card
    const executions1002 = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.intent === 'ACCEPT_ORDER' && l.payload?.orderId === 1002 && l.payload?.payment === 'card');
    });
    expect(executions1002.length).toBe(1);
    expect(executions1002[0].payload).toEqual({ orderId: 1002, payment: 'card' });

    // Validate strictly 0 executions for 1001 + card
    const executions1001 = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.intent === 'ACCEPT_ORDER' && l.payload?.orderId === 1001);
    });
    expect(executions1001.length).toBe(0);

    // Validate real FSM transition to ORDER_ACCEPTED
    await expect(fsmLocator).toHaveText(/ORDER_ACCEPTED|Принят/i);
  });

  test('CROSS-CONTEXT-01: Full log audit proves zero mixed or contaminated payloads', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, '1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');
    await emitVoicePhrase(page, 'Картой');

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());

    // Disallowed combinations
    const contaminated1001Card = logs.filter((l: any) => l.payload?.orderId === 1001 && l.payload?.payment === 'card');
    const contaminated1001Cash = logs.filter((l: any) => l.payload?.orderId === 1001 && l.payload?.payment === 'cash');
    const contaminated1002Cash = logs.filter((l: any) => l.payload?.orderId === 1002 && l.payload?.payment === 'cash');

    expect(contaminated1001Card.length).toBe(0);
    expect(contaminated1001Cash.length).toBe(0);
    expect(contaminated1002Cash.length).toBe(0);
  });

  test('NEG-01: Subsequent slot value belongs strictly to active context (1002)', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, '1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');
    await emitVoicePhrase(page, 'Картой');

    const total1002 = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.payload?.orderId === 1002 && l.payload?.payment === 'card').length;
    });
    const total1001 = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.payload?.orderId === 1001).length;
    });

    expect(total1002).toBe(1);
    expect(total1001).toBe(0);
  });

  test('NEG-02: Old order value cannot be resurrected after new context completion', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, '1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');
    await emitVoicePhrase(page, 'Наличными');

    const matching1002 = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.payload?.orderId === 1002 && l.payload?.payment === 'cash').length;
    });
    const matching1001 = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.payload?.orderId === 1001).length;
    });

    expect(matching1002).toBe(1);
    expect(matching1001).toBe(0);
  });

  test('NEG-03: Switching to independent intent (DRIVER_ARRIVED) permanently disables ACCEPT_ORDER 1001', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, '1001');
    await emitVoicePhrase(page, 'Я приехал');
    await emitVoicePhrase(page, 'Картой');

    const executions1001 = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.intent === 'ACCEPT_ORDER' && l.payload?.orderId === 1001).length;
    });

    expect(executions1001).toBe(0);
  });

  test('RECOVERY-01: Error recovery on order 1002 preserves 1002 context and excludes 1001', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, '1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');
    await emitVoicePhrase(page, 'Не знаю');
    await emitVoicePhrase(page, 'Картой');

    const state = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getActiveState());
    expect(state.status).toBe('COMPLETED');
    expect(state.slots).toEqual({ orderId: 1002, payment: 'card' });

    const executions1002 = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.payload?.orderId === 1002 && l.payload?.payment === 'card').length;
    });
    const executions1001 = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.payload?.orderId === 1001).length;
    });

    expect(executions1002).toBe(1);
    expect(executions1001).toBe(0);
  });

  test('IDEMP-01: Duplicate voice utterances on order 1002 result in strictly executionCount === 1', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, '1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');
    await emitVoicePhrase(page, 'Картой');

    // Duplicate utterances
    await emitVoicePhrase(page, 'Картой');
    await emitVoicePhrase(page, '1002');
    await emitVoicePhrase(page, 'Прими заказ 1002 с оплатой картой');

    const count1002 = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.intent === 'ACCEPT_ORDER' && l.payload?.orderId === 1002 && l.payload?.payment === 'card').length;
    });

    expect(count1002).toBe(1);
  });

});
