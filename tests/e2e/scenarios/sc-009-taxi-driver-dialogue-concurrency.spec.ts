import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-sc-009-taxi-driver-dialogue-concurrency.json');

test.describe('E2E: SC-009 Concurrent Multi-Context Regression Suite (ТЗ-VOICE-SC-009)', () => {

  async function setupApp(page: any) {
    const appUrl = process.env.APP_URL || 'https://voice-assistant-two-olive.vercel.app';
    await page.goto(appUrl);
    await expect(page.locator('body')).toBeVisible();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(scenarioFilePath);
    
    const activeSetId = await page.evaluate(() => {
      return (window as any).__SCENARIO_ENGINE__.getActiveScenarioSetId();
    });
    expect(activeSetId).toBe('scenario-set-sc-009-taxi-driver-dialogue-concurrency');
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

  test('CONTEXT-01 & 02: Creating 1001 and 1002 concurrently preserves both contexts in WAITING_FOR_SLOT', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    expect(contexts.length).toBe(2);

    const ctxA = contexts.find((c: any) => c.slots.orderId === 1001);
    const ctxB = contexts.find((c: any) => c.slots.orderId === 1002);

    expect(ctxA.status).toBe('WAITING_FOR_SLOT');
    expect(ctxB.status).toBe('WAITING_FOR_SLOT');
    expect(ctxA.contextId).not.toBe(ctxB.contextId);
  });

  test('CONTEXT-03 & 04 & CROSS-CONTEXT-01: Independent slot filling produces exact separate executions', async ({ page }) => {
    await setupApp(page);

    // 1. Create two contexts
    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const idA = contexts.find((c: any) => c.slots.orderId === 1001).contextId;
    const idB = contexts.find((c: any) => c.slots.orderId === 1002).contextId;

    // 2. Fill Context A (1001)
    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Картой');

    // 3. Fill Context B (1002)
    await emitVoicePhrase(page, 'Заказ 1002');
    await emitVoicePhrase(page, 'Наличными');

    // 4. Verify exact isolated executions
    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    const matchA = logs.filter((l: any) => l.contextId === idA && l.event.payload.orderId === 1001 && l.event.payload.payment === 'card');
    const matchB = logs.filter((l: any) => l.contextId === idB && l.event.payload.orderId === 1002 && l.event.payload.payment === 'cash');

    expect(matchA.length).toBe(1);
    expect(matchB.length).toBe(1);
  });

  test('CROSS-CONTEXT-02: Zero slot or payload contamination between 1001 and 1002', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Картой');

    await emitVoicePhrase(page, 'Заказ 1002');
    await emitVoicePhrase(page, 'Наличными');

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    const contaminated1001Cash = logs.filter((l: any) => l.event.payload.orderId === 1001 && l.event.payload.payment === 'cash');
    const contaminated1002Card = logs.filter((l: any) => l.event.payload.orderId === 1002 && l.event.payload.payment === 'card');

    expect(contaminated1001Cash.length).toBe(0);
    expect(contaminated1002Card.length).toBe(0);
  });

  test('CROSS-CONTEXT-03 & NEG-01: Independent cancellation of 1001 preserves 1002 completion', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    // Cancel 1001 only
    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Отмена');

    // Complete 1002
    await emitVoicePhrase(page, 'Заказ 1002');
    await emitVoicePhrase(page, 'Наличными');

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    const match1001 = logs.filter((l: any) => l.event.payload.orderId === 1001);
    const match1002 = logs.filter((l: any) => l.event.payload.orderId === 1002 && l.event.payload.payment === 'cash');

    expect(match1001.length).toBe(0);
    expect(match1002.length).toBe(1);
  });

  test('IDEMP-01 & IDEMP-02: Idempotency per context does not leak across dialogues', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Картой');
    await emitVoicePhrase(page, 'Картой'); // Duplicate on 1001

    await emitVoicePhrase(page, 'Заказ 1002');
    await emitVoicePhrase(page, 'Картой'); // Same payment on 1002

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    const match1001 = logs.filter((l: any) => l.event.payload.orderId === 1001 && l.event.payload.payment === 'card');
    const match1002 = logs.filter((l: any) => l.event.payload.orderId === 1002 && l.event.payload.payment === 'card');

    expect(match1001.length).toBe(1);
    expect(match1002.length).toBe(1);
  });

});
