import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-sc-010-taxi-driver-multi-context-lifecycle.json');

test.describe('E2E: SC-010 Multi-Context Complete Lifecycle Suite (ТЗ-VOICE-SC-010)', () => {

  async function setupApp(page: any) {
    const appUrl = process.env.APP_URL || 'https://voice-assistant-two-olive.vercel.app';
    await page.goto(appUrl);
    await expect(page.locator('body')).toBeVisible();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(scenarioFilePath);

    const activeSetId = await page.evaluate(() => {
      return (window as any).__SCENARIO_ENGINE__.getActiveScenarioSetId();
    });
    expect(activeSetId).toBe('scenario-set-sc-010-taxi-driver-multi-context-lifecycle');
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

  test('WORKFLOW-01: Concurrent creation of 3 independent contexts (1001, 1002, 1003) with unique contextIds', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');
    await emitVoicePhrase(page, 'Прими заказ 1003');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    expect(contexts.length).toBe(3);

    const ctxA = contexts.find((c: any) => c.slots.orderId === 1001);
    const ctxB = contexts.find((c: any) => c.slots.orderId === 1002);
    const ctxC = contexts.find((c: any) => c.slots.orderId === 1003);

    expect(ctxA.status).toBe('WAITING_FOR_SLOT');
    expect(ctxB.status).toBe('WAITING_FOR_SLOT');
    expect(ctxC.status).toBe('WAITING_FOR_SLOT');

    expect(ctxA.contextId).not.toBe(ctxB.contextId);
    expect(ctxA.contextId).not.toBe(ctxC.contextId);
    expect(ctxB.contextId).not.toBe(ctxC.contextId);
  });

  test('WORKFLOW-02: Diverse completion of 3 contexts (1001->Card, 1002->Cancel, 1003->Cash) with exact contextId correlation', async ({ page }) => {
    await setupApp(page);

    // 1. Create 3 contexts
    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');
    await emitVoicePhrase(page, 'Прими заказ 1003');

    const contextsBefore = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const idA = contextsBefore.find((c: any) => c.slots.orderId === 1001).contextId;
    const idB = contextsBefore.find((c: any) => c.slots.orderId === 1002).contextId;
    const idC = contextsBefore.find((c: any) => c.slots.orderId === 1003).contextId;

    // 2. Complete 1001 with Card
    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Картой');

    // 3. Cancel 1002
    await emitVoicePhrase(page, 'Заказ 1002');
    await emitVoicePhrase(page, 'Отмена');

    // 4. Complete 1003 with Cash
    await emitVoicePhrase(page, 'Заказ 1003');
    await emitVoicePhrase(page, 'Наличными');

    // Verify statuses
    const contextsAfter = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    expect(contextsAfter.find((c: any) => c.contextId === idA).status).toBe('COMPLETED');
    expect(contextsAfter.find((c: any) => c.contextId === idB).status).toBe('CANCELLED');
    expect(contextsAfter.find((c: any) => c.contextId === idC).status).toBe('COMPLETED');

    // Verify executions correlated to contextId
    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    const match1001 = logs.filter((l: any) => l.contextId === idA && l.event.payload.orderId === 1001 && l.event.payload.payment === 'card');
    const match1002 = logs.filter((l: any) => l.contextId === idB);
    const match1003 = logs.filter((l: any) => l.contextId === idC && l.event.payload.orderId === 1003 && l.event.payload.payment === 'cash');

    expect(match1001.length).toBe(1);
    expect(match1001[0].contextId).toBe(idA);
    expect(match1002.length).toBe(0); // 0 executions for cancelled
    expect(match1003.length).toBe(1);
    expect(match1003[0].contextId).toBe(idC);
    expect(logs.length).toBe(2);
  });

  test('WORKFLOW-03: Context switching after completion and cancelled context resurrection protection', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');
    await emitVoicePhrase(page, 'Прими заказ 1003');

    const contextsBefore = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const idA = contextsBefore.find((c: any) => c.slots.orderId === 1001).contextId;
    const idB = contextsBefore.find((c: any) => c.slots.orderId === 1002).contextId;
    const idC = contextsBefore.find((c: any) => c.slots.orderId === 1003).contextId;

    // 1. Complete 1001
    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Картой');

    // 2. Switch to 1003 and complete it with cash
    await emitVoicePhrase(page, 'Заказ 1003');
    await emitVoicePhrase(page, 'Наличными');

    // 3. Verify 1001 remains COMPLETED with strictly 1 execution after switching
    const contextsMid = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    expect(contextsMid.find((c: any) => c.contextId === idA).status).toBe('COMPLETED');
    expect(contextsMid.find((c: any) => c.contextId === idC).status).toBe('COMPLETED');

    // 4. Cancel 1002
    await emitVoicePhrase(page, 'Заказ 1002');
    await emitVoicePhrase(page, 'Отмена');

    // 5. Attempt to resurrect cancelled 1002
    await emitVoicePhrase(page, 'Заказ 1002');
    await emitVoicePhrase(page, 'Наличными');

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    const countA = logs.filter((l: any) => l.contextId === idA).length;
    const countB = logs.filter((l: any) => l.contextId === idB).length;
    const countC = logs.filter((l: any) => l.contextId === idC).length;

    expect(countA).toBe(1);
    expect(countB).toBe(0); // Cancelled context did NOT resurrect
    expect(countC).toBe(1);
  });

  test('CROSS-CONTEXT-NEGATIVE: Zero invalid combinations with exact contextId and payload correlation', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');
    await emitVoicePhrase(page, 'Прими заказ 1003');

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const idA = contexts.find((c: any) => c.slots.orderId === 1001).contextId;
    const idB = contexts.find((c: any) => c.slots.orderId === 1002).contextId;
    const idC = contexts.find((c: any) => c.slots.orderId === 1003).contextId;

    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Картой');

    await emitVoicePhrase(page, 'Заказ 1002');
    await emitVoicePhrase(page, 'Отмена');

    await emitVoicePhrase(page, 'Заказ 1003');
    await emitVoicePhrase(page, 'Наличными');

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());

    // Strict cross-context negative checks including contextId correlation
    const cA_cash = logs.filter((l: any) => l.contextId === idA && l.event.payload.payment === 'cash');
    const cB_any = logs.filter((l: any) => l.contextId === idB);
    const cC_card = logs.filter((l: any) => l.contextId === idC && l.event.payload.payment === 'card');

    expect(cA_cash.length).toBe(0);
    expect(cB_any.length).toBe(0);
    expect(cC_card.length).toBe(0);
  });

  test('RECOVERY-04: Fourth context (1004) error recovery preserves states, contextIds, and executions of 1001-1003', async ({ page }) => {
    await setupApp(page);

    // 1. Initial 3 contexts setup
    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Прими заказ 1002');
    await emitVoicePhrase(page, 'Прими заказ 1003');

    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Картой');

    await emitVoicePhrase(page, 'Заказ 1002');
    await emitVoicePhrase(page, 'Отмена');

    await emitVoicePhrase(page, 'Заказ 1003');
    await emitVoicePhrase(page, 'Наличными');

    // 2. Snapshot of contexts 1001-1003 BEFORE 1004
    const snapshotBefore = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm.listContexts().map((c: any) => ({
        contextId: c.contextId,
        orderId: c.slots.orderId,
        status: c.status,
        slots: { ...c.slots }
      }));
    });
    expect(snapshotBefore.length).toBe(3);

    // 3. Create 4th context with invalid turn recovery
    await emitVoicePhrase(page, 'Прими заказ 1004');
    await emitVoicePhrase(page, 'Не знаю'); // invalid turn

    let state1004 = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getActiveState());
    expect(state1004.status).toBe('WAITING_FOR_SLOT');
    expect(state1004.slots.orderId).toBe(1004);

    await emitVoicePhrase(page, 'Наличными'); // recovery turn
    state1004 = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getActiveState());
    expect(state1004.status).toBe('COMPLETED');
    const id1004 = state1004.contextId;

    // 4. Verify snapshot of contexts 1001-1003 AFTER 1004 (Strict immutability proof)
    const contextsAfter = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    expect(contextsAfter.length).toBe(4);

    for (const snap of snapshotBefore) {
      const current = contextsAfter.find((c: any) => c.contextId === snap.contextId);
      expect(current).toBeDefined();
      expect(current.slots.orderId).toBe(snap.orderId);
      expect(current.status).toBe(snap.status);
      expect(current.slots).toEqual(snap.slots);
    }

    // 5. Verify executions
    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    const match1004 = logs.filter((l: any) => l.contextId === id1004 && l.event.payload.orderId === 1004 && l.event.payload.payment === 'cash');

    expect(match1004.length).toBe(1);
    expect(logs.length).toBe(3); // strictly 1001, 1003, 1004
  });

  test('IDEMP-03: Repeated slot filling on completed contexts preserves executionCount === 1 with contextId correlation', async ({ page }) => {
    await setupApp(page);

    await emitVoicePhrase(page, 'Прими заказ 1001');
    await emitVoicePhrase(page, 'Заказ 1001');
    await emitVoicePhrase(page, 'Картой');
    await emitVoicePhrase(page, 'Картой'); // duplicate

    await emitVoicePhrase(page, 'Прими заказ 1003');
    await emitVoicePhrase(page, 'Заказ 1003');
    await emitVoicePhrase(page, 'Наличными');
    await emitVoicePhrase(page, 'Наличными'); // duplicate

    const contexts = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.listContexts());
    const idA = contexts.find((c: any) => c.slots.orderId === 1001).contextId;
    const idC = contexts.find((c: any) => c.slots.orderId === 1003).contextId;

    const logs = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs());
    const countA = logs.filter((l: any) => l.contextId === idA && l.event.payload.orderId === 1001 && l.event.payload.payment === 'card').length;
    const countC = logs.filter((l: any) => l.contextId === idC && l.event.payload.orderId === 1003 && l.event.payload.payment === 'cash').length;

    expect(countA).toBe(1);
    expect(countC).toBe(1);
  });

});
