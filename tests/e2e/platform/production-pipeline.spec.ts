import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-platform-012-production-pipeline.json');

test.describe('E2E: PLATFORM-012 Production Voice Pipeline Integration Suite', () => {

  async function setupApp(page: any) {
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    await page.goto(appUrl);
    await expect(page.locator('body')).toBeVisible();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(scenarioFilePath);

    const activeSetId = await page.evaluate(() => {
      return (window as any).__SCENARIO_ENGINE__.getActiveScenarioSetId();
    });
    expect(activeSetId).toBe('scenario-set-platform-012-production-pipeline');
  }

  async function emitVoicePhrase(page: any, phrase: string) {
    return page.evaluate(async (text: string) => {
      const channel = (window as any).__VOICE_CHANNEL__;
      if (!channel) {
        throw new Error('VoiceChannel production instance is not initialized on window.__VOICE_CHANNEL__');
      }
      return channel.handleIncomingVoice(text);
    }, phrase);
  }

  test('PIPELINE-E2E-01: End-to-end single order workflow through production VoiceChannel and Action Dispatch', async ({ page }) => {
    await setupApp(page);

    // 1. Voice input -> createContext
    await emitVoicePhrase(page, 'Прими заказ 1001');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    expect(contexts.length).toBe(1);
    expect(contexts[0].status).toBe('WAITING_FOR_SLOT');
    expect(contexts[0].slots.orderId).toBe(1001);

    // 2. Slot filling -> COMPLETED -> Action Dispatch
    await emitVoicePhrase(page, 'Картой');

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    expect(logs.length).toBe(1);
    expect(logs[0].event.type).toBe('driver.order.accepted');
    expect(logs[0].event.payload).toEqual({ orderId: 1001, payment: 'card' });
  });

  test('PIPELINE-E2E-02: Concurrent Multi-Context execution on production pipeline', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const idA = contexts.find((c: any) => c.slots.orderId === 1001).contextId;
    const idB = contexts.find((c: any) => c.slots.orderId === 1002).contextId;

    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Картой');

    await emitVoicePhrase(page, 'Заказ 1002');
    await emitVoicePhrase(page, 'Наличными');

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    const matchA = logs.filter((l: any) => l.contextId === idA && l.event.payload.orderId === 1001 && l.event.payload.payment === 'card');
    const matchB = logs.filter((l: any) => l.contextId === idB && l.event.payload.orderId === 1002 && l.event.payload.payment === 'cash');

    expect(matchA.length).toBe(1);
    expect(matchB.length).toBe(1);
  });

  test('PIPELINE-E2E-03: Ambiguity guard and explicit resolution on production pipeline', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    // Unaddressed utterance -> AMBIGUOUS_CONTEXT
    const ambRes = await emitVoicePhrase(page, 'Картой');
    expect(ambRes.status).toBe('AMBIGUOUS_CONTEXT');

    let logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    expect(logs.length).toBe(0);

    // Explicit entity clarification
    await emitVoicePhrase(page, 'Заказ 1002');
    await emitVoicePhrase(page, 'Картой');

    logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    expect(logs.length).toBe(1);
    expect(logs[0].event.payload.orderId).toBe(1002);
  });

  test('PIPELINE-E2E-04: Ambiguity-safe cancellation protects multiple contexts on production pipeline', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    // Unaddressed cancel with 2 active contexts
    const cancelRes = await emitVoicePhrase(page, 'Отмена');
    expect(cancelRes.status).toBe('AMBIGUOUS_CONTEXT');

    // Explicit cancel for 1002
    await emitVoicePhrase(page, 'Заказ 1002 отмена');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const ctxB = contexts.find((c: any) => c.slots.orderId === 1002);
    const ctxA = contexts.find((c: any) => c.slots.orderId === 1001);

    expect(ctxB.status).toBe('CANCELLED');
    expect(ctxA.status).toBe('WAITING_FOR_SLOT');
  });

  test('PIPELINE-E2E-05: Non-matching utterance returns NO_MATCH with zero executions', async ({ page }) => {
    await setupApp(page);

    const res = await emitVoicePhrase(page, 'Неизвестная команда');
    expect(res.status).toBe('NO_MATCH');

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    expect(logs.length).toBe(0);
  });

  test('PIPELINE-E2E-06: Production Action Dispatch triggers arrived event seamlessly', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Я приехал');

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    expect(logs.length).toBe(1);
    expect(logs[0].event.type).toBe('driver.arrived');
  });

});
