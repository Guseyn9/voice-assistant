import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-platform-010-multi-context.json');

test.describe('E2E: PLATFORM-010 Multi-Context Session Manager Runtime Suite', () => {

  async function setupApp(page: any) {
    const appUrl = process.env.APP_URL || 'https://voice-assistant-two-olive.vercel.app';
    await page.goto(appUrl);
    await expect(page.locator('body')).toBeVisible();

    // 1. Load own PLATFORM-010 scenario
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(scenarioFilePath);

    const activeSetId = await page.evaluate(() => {
      return (window as any).__SCENARIO_ENGINE__.getActiveScenarioSetId();
    });
    expect(activeSetId).toBe('scenario-set-platform-010-multi-context');
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

  test('MULTICONTEXT-E2E-01 & 02: Create Context A and Context B concurrently without destroying A', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    const contexts = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm?.listContexts() || [];
    });

    expect(contexts.length).toBe(2);
    const ctxA = contexts.find((c: any) => c.slots.orderId === 1001);
    const ctxB = contexts.find((c: any) => c.slots.orderId === 1002);

    expect(ctxA.status).toBe('WAITING_FOR_SLOT');
    expect(ctxB.status).toBe('WAITING_FOR_SLOT');
    expect(ctxA.contextId).not.toBe(ctxB.contextId);
  });

  test('MULTICONTEXT-E2E-03 & 04: Routing and Execution correlation to concrete contextId', async ({ page }) => {
    await setupApp(page);

    // 1. Create two contexts
    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    const contextsBefore = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const idA = contextsBefore.find((c: any) => c.slots.orderId === 1001).contextId;
    const idB = contextsBefore.find((c: any) => c.slots.orderId === 1002).contextId;

    // 2. Route via VoiceChannel to 1001
    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Картой');

    // 3. Route via VoiceChannel to 1002
    await emitVoicePhrase(page, 'Заказ 1002');
    await emitVoicePhrase(page, 'Наличными');

    // 4. Assert execution correlation with exact contextId
    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    const match1001 = logs.filter((l: any) => l.contextId === idA);
    const match1002 = logs.filter((l: any) => l.contextId === idB);

    expect(match1001.length).toBe(1);
    expect(match1001[0].contextId).toBe(idA);
    expect(match1001[0].event.type).toBe('driver.order.accepted');
    expect(match1001[0].event.payload).toEqual({ orderId: 1001, payment: 'card' });

    expect(match1002.length).toBe(1);
    expect(match1002[0].contextId).toBe(idB);
    expect(match1002[0].event.type).toBe('driver.order.accepted');
    expect(match1002[0].event.payload).toEqual({ orderId: 1002, payment: 'cash' });
  });

  test('MULTICONTEXT-E2E-05: Switch A -> B -> A preserving slot values and activeContextId', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const idA = contexts.find((c: any) => c.slots.orderId === 1001).contextId;
    const idB = contexts.find((c: any) => c.slots.orderId === 1002).contextId;

    await emitVoicePhrase(page, 'Заказ 1001');
    let activeState = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getActiveState());
    expect(activeState.contextId).toBe(idA);
    expect(activeState.slots.orderId).toBe(1001);

    await emitVoicePhrase(page, 'Заказ 1002');
    activeState = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getActiveState());
    expect(activeState.contextId).toBe(idB);
    expect(activeState.slots.orderId).toBe(1002);
  });

  test('MULTICONTEXT-E2E-06: Cancel A preserves B in WAITING_FOR_SLOT', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Отмена');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const ctxA = contexts.find((c: any) => c.slots.orderId === 1001);
    const ctxB = contexts.find((c: any) => c.slots.orderId === 1002);

    expect(ctxA.status).toBe('CANCELLED');
    expect(ctxB.status).toBe('WAITING_FOR_SLOT');
  });

  test('MULTICONTEXT-E2E-07: Expire A preserves B in WAITING_FOR_SLOT', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const ctxA = dm.listContexts().find((c: any) => c.slots.orderId === 1001);
      if (ctxA) dm.expireContext(ctxA.contextId);
    });

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const ctxA = contexts.find((c: any) => c.slots.orderId === 1001);
    const ctxB = contexts.find((c: any) => c.slots.orderId === 1002);

    expect(ctxA.status).toBe('EXPIRED');
    expect(ctxB.status).toBe('WAITING_FOR_SLOT');
  });

  test('MULTICONTEXT-E2E-08: Idempotency per contextId with same slot value', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const idA = contexts.find((c: any) => c.slots.orderId === 1001).contextId;
    const idB = contexts.find((c: any) => c.slots.orderId === 1002).contextId;

    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Картой');
    await emitVoicePhrase(page, 'Картой'); // Duplicate on 1001

    await emitVoicePhrase(page, 'Заказ 1002');
    await emitVoicePhrase(page, 'Картой'); // Same payment slot on 1002

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    const matchA = logs.filter((l: any) => l.contextId === idA);
    const matchB = logs.filter((l: any) => l.contextId === idB);

    expect(matchA.length).toBe(1);
    expect(matchB.length).toBe(1);
  });

  test('MULTICONTEXT-E2E-09 & 10: Cross-context isolation and contamination protection', async ({ page }) => {
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

});
