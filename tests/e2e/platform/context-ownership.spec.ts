import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-platform-013-context-ownership.json');

test.describe('E2E: PLATFORM-013 Context Ownership & Session Isolation Suite', () => {

  const sessionA = { ownerId: 'driver-001', sessionId: 'session-A' };
  const sessionB = { ownerId: 'driver-002', sessionId: 'session-B' };

  async function setupApp(page: any) {
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    await page.goto(appUrl);
    await expect(page.locator('body')).toBeVisible();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(scenarioFilePath);

    const activeSetId = await page.evaluate(() => {
      return (window as any).__SCENARIO_ENGINE__.getActiveScenarioSetId();
    });
    expect(activeSetId).toBe('scenario-set-platform-013-context-ownership');
  }

  async function emitVoice(page: any, phrase: string, identity: { ownerId: string; sessionId: string }) {
    return page.evaluate(async ({ text, id }) => {
      const channel = (window as any).__VOICE_CHANNEL__;
      if (!channel) {
        throw new Error('VoiceChannel is not initialized');
      }
      return channel.handleIncomingVoice(text, id);
    }, { text: phrase, id: identity });
  }

  test('E2E-OWNERSHIP-01: Session B cannot access or resolve Context of Session A via explicit entity', async ({ page }) => {
    await setupApp(page);

    // Session A creates context 1001
    await emitVoice(page, 'Прими заказ 1001', sessionA);

    // Session B attempts explicit addressing of 1001
    const resB = await emitVoice(page, 'Заказ 1001', sessionB);
    expect(resB.status).toBe('CONTEXT_ACCESS_DENIED');

    const logsA = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs(id), sessionA);
    const logsB = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs(id), sessionB);
    expect(logsA.length).toBe(0);
    expect(logsB.length).toBe(0);
  });

  test('E2E-OWNERSHIP-02: Unaddressed slot utterance from Session B does not mutate Session A context', async ({ page }) => {
    await setupApp(page);

    await emitVoice(page, 'Прими заказ 1001', sessionA);

    // Session B sends unaddressed payment
    const resB = await emitVoice(page, 'Картой', sessionB);
    expect(resB.status).toBe('NO_MATCH');

    const contextsA = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.listContexts(id), sessionA);
    expect(contextsA.length).toBe(1);
    expect(contextsA[0].status).toBe('WAITING_FOR_SLOT');
    expect(contextsA[0].slots.payment).toBeUndefined();
  });

  test('E2E-OWNERSHIP-03: Unaddressed cancellation from Session B does not cancel Session A context', async ({ page }) => {
    await setupApp(page);

    await emitVoice(page, 'Прими заказ 1001', sessionA);

    // Session B sends unaddressed cancel
    const resB = await emitVoice(page, 'Отмена', sessionB);
    expect(resB.status).toBe('NO_MATCH');

    const contextsA = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.listContexts(id), sessionA);
    expect(contextsA[0].status).toBe('WAITING_FOR_SLOT');
  });

  test('E2E-OWNERSHIP-04: Identical orderId across distinct sessions maintains separate contextId and isolation', async ({ page }) => {
    await setupApp(page);

    await emitVoice(page, 'Прими заказ 1001', sessionA);
    await emitVoice(page, 'Прими заказ 1001', sessionB);

    const listA = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.listContexts(id), sessionA);
    const listB = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.listContexts(id), sessionB);

    expect(listA.length).toBe(1);
    expect(listB.length).toBe(1);
    expect(listA[0].contextId).not.toBe(listB[0].contextId);

    // Complete A with card, B with cash
    await emitVoice(page, 'Заказ 1001', sessionA);
    await emitVoice(page, 'Картой', sessionA);

    await emitVoice(page, 'Заказ 1001', sessionB);
    await emitVoice(page, 'Наличными', sessionB);

    const logsA = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs(id), sessionA);
    const logsB = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs(id), sessionB);

    expect(logsA.length).toBe(1);
    expect(logsA[0].event.payload.payment).toBe('card');

    expect(logsB.length).toBe(1);
    expect(logsB[0].event.payload.payment).toBe('cash');
  });

  test('E2E-OWNERSHIP-05: Ambiguity calculation is scoped strictly within current session boundaries', async ({ page }) => {
    await setupApp(page);

    // Session A creates 1001, 1002
    await emitVoice(page, 'Прими заказ 1001', sessionA);
    await emitVoice(page, 'Прими заказ 1002', sessionA);

    // Session B creates 2001
    await emitVoice(page, 'Прими заказ 2001', sessionB);

    const ambA = await emitVoice(page, 'Картой', sessionA);
    expect(ambA.status).toBe('AMBIGUOUS_CONTEXT');
    expect(ambA.candidateContextIds.length).toBe(2);

    const listB = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.listContexts(id), sessionB);
    expect(ambA.candidateContextIds).not.toContain(listB[0].contextId);
  });

  test('E2E-OWNERSHIP-06: Explicit cancellation targeting foreign context is denied', async ({ page }) => {
    await setupApp(page);

    await emitVoice(page, 'Прими заказ 2001', sessionB);

    // Session A attempts explicit cancellation of Session B order 2001
    const cancelRes = await emitVoice(page, 'Заказ 2001 отмена', sessionA);
    expect(cancelRes.status).toBe('CONTEXT_ACCESS_DENIED');

    const ctxB = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.listContexts(id), sessionB);
    expect(ctxB[0].status).toBe('WAITING_FOR_SLOT');
  });

});
