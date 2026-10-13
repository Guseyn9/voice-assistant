import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-platform-011-ambiguous-context.json');

test.describe('E2E: PLATFORM-011 Ambiguous Input & Context Selection Suite', () => {

  async function setupApp(page: any) {
    const appUrl = process.env.APP_URL || 'https://voice-assistant-two-olive.vercel.app';
    await page.goto(appUrl);
    await expect(page.locator('body')).toBeVisible();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(scenarioFilePath);

    const activeSetId = await page.evaluate(() => {
      return (window as any).__SCENARIO_ENGINE__.getActiveScenarioSetId();
    });
    expect(activeSetId).toBe('scenario-set-platform-011-ambiguous-context');
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

  test('E2E-AMBIGUITY-01: Unaddressed utterance returns AMBIGUOUS_CONTEXT, declarative clarificationPrompt and zero execution, resolved via explicit entity', async ({ page }) => {
    await setupApp(page);

    // 1. Create two contexts waiting for payment
    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    expect(contexts.length).toBe(2);
    const idA = contexts.find((c: any) => c.slots.orderId === 1001).contextId;
    const idB = contexts.find((c: any) => c.slots.orderId === 1002).contextId;

    // 2. Ambiguous voice input
    const ambResult = await emitVoicePhrase(page, 'Картой');
    expect(ambResult.status).toBe('AMBIGUOUS_CONTEXT');
    expect(ambResult.candidateContextIds).toContain(idA);
    expect(ambResult.candidateContextIds).toContain(idB);
    expect(ambResult.clarificationPrompt).toContain('1001');
    expect(ambResult.clarificationPrompt).toContain('1002');

    // 3. Verify zero execution
    let logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    expect(logs.length).toBe(0);

    // 4. Clarification via explicit entity
    const resolveResult = await emitVoicePhrase(page, 'Заказ 1002');
    expect(resolveResult.status).toBe('WAITING_FOR_SLOT');
    expect(resolveResult.contextId).toBe(idB);

    // 5. Fill slot for resolved 1002
    await emitVoicePhrase(page, 'Картой');

    // 6. Verify single execution strictly correlated to 1002
    logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    expect(logs.length).toBe(1);
    expect(logs[0].contextId).toBe(idB);
    expect(logs[0].event.type).toBe('driver.order.accepted');
    expect(logs[0].event.payload.orderId).toBe(1002);
    expect(logs[0].event.payload.payment).toBe('card');

    // Verify 1001 remains in WAITING_FOR_SLOT with 0 executions
    const ctxA = await page.evaluate((id: string) => (window as any).__DIALOGUE_MANAGER__.getContext(id), idA);
    expect(ctxA.status).toBe('WAITING_FOR_SLOT');
  });

  test('E2E-AMBIGUITY-02: ActiveContext is NOT silently used to bypass ambiguity', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const idA = contexts.find((c: any) => c.slots.orderId === 1001).contextId;

    // Set activeContext to 1001
    await page.evaluate((id: string) => (window as any).__DIALOGUE_MANAGER__.activateContext(id), idA);
    const currentActive = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getActiveContextId());
    expect(currentActive).toBe(idA);

    // Unaddressed utterance
    const ambResult = await emitVoicePhrase(page, 'Картой');
    expect(ambResult.status).toBe('AMBIGUOUS_CONTEXT');

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    expect(logs.length).toBe(0);
  });

  test('E2E-AMBIGUITY-03: Single remaining context automatically resolves after completion of the first', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const idA = contexts.find((c: any) => c.slots.orderId === 1001).contextId;
    const idB = contexts.find((c: any) => c.slots.orderId === 1002).contextId;

    // Complete 1001 explicitly
    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Картой');

    // Unaddressed utterance now has only 1 candidate (1002)
    await emitVoicePhrase(page, 'Наличными');

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    expect(logs.length).toBe(2);

    const matchA = logs.filter((l: any) => l.contextId === idA && l.event.payload.orderId === 1001 && l.event.payload.payment === 'card');
    const matchB = logs.filter((l: any) => l.contextId === idB && l.event.payload.orderId === 1002 && l.event.payload.payment === 'cash');

    expect(matchA.length).toBe(1);
    expect(matchB.length).toBe(1);
  });

  test('E2E-AMBIGUITY-04: Full VoiceChannel NO_MATCH chain produces zero execution', async ({ page }) => {
    await setupApp(page);

    // No active contexts created
    const res = await emitVoicePhrase(page, 'Неизвестная фраза без совпадения');
    expect(res.status).toBe('NO_MATCH');

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    expect(logs.length).toBe(0);
  });

  test('E2E-AMBIGUITY-05: Ambiguity-safe cancellation protects multiple contexts and supports explicit cancellation', async ({ page }) => {
    await setupApp(page);

    // 1. Create two contexts
    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const idA = contexts.find((c: any) => c.slots.orderId === 1001).contextId;
    const idB = contexts.find((c: any) => c.slots.orderId === 1002).contextId;

    // 2. Unaddressed cancellation with 2 active contexts
    const cancelAmbRes = await emitVoicePhrase(page, 'Отмена');
    expect(cancelAmbRes.status).toBe('AMBIGUOUS_CONTEXT');
    expect(cancelAmbRes.candidateContextIds).toContain(idA);
    expect(cancelAmbRes.candidateContextIds).toContain(idB);

    // Verify 0 contexts cancelled
    let activeWaiting = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts().filter((c: any) => c.status === 'WAITING_FOR_SLOT'));
    expect(activeWaiting.length).toBe(2);

    // 3. Explicit cancellation of 1002
    await emitVoicePhrase(page, 'Заказ 1002 отмена');

    const ctxB = await page.evaluate((id: string) => (window as any).__DIALOGUE_MANAGER__.getContext(id), idB);
    const ctxA = await page.evaluate((id: string) => (window as any).__DIALOGUE_MANAGER__.getContext(id), idA);

    expect(ctxB.status).toBe('CANCELLED');
    expect(ctxA.status).toBe('WAITING_FOR_SLOT');

    // 4. Complete remaining 1001
    await emitVoicePhrase(page, 'Картой'); // Now single candidate (1001), resolves automatically

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    expect(logs.length).toBe(1);
    expect(logs[0].contextId).toBe(idA);
    expect(logs[0].event.payload.orderId).toBe(1001);
    expect(logs[0].event.payload.payment).toBe('card');
  });

});
