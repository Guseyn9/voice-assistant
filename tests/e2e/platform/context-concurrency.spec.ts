import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-platform-016-context-concurrency.json');

test.describe('E2E: PLATFORM-016 Concurrency Control Suite', () => {

  async function setupApp(page: any) {
    await page.addInitScript(() => {
      (window as any).__AUTH_OWNER_ID__ = 'driver-001';
      (window as any).__AUTH_SESSION_ID__ = 'session-prod-001';
    });

    await page.goto('http://localhost:3000');
    await page.waitForSelector('#voice-app-ready', { timeout: 10000 });

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(scenarioFilePath);
  }

  test('E2E-RACE-01: Voice x Declarative System Event race deterministically serializes', async ({ page }) => {
    await setupApp(page);

    const result = await page.evaluate(async () => {
      const vc = (window as any).__VOICE_CHANNEL__;
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const app = (window as any).__VOICE_DEMO_APP__;
      const identity = app.getIdentity();

      const ctx = dm.createContext('ORDER_PAYMENT', {}, ['paymentMethod'], 'order.payment.completed', {}, identity);

      const [voiceRes, sysRes] = await Promise.all([
        vc.handleIncomingVoice('картой', identity),
        dm.handleSystemEvent(ctx.contextId, { type: 'DRIVER_CANCEL', targetTransition: 'CANCEL' }, identity)
      ]);

      const finalCtx = dm.getContext(ctx.contextId, identity);
      return { finalCtx, logs: dm.getExecutionLogs(identity), voiceRes, sysRes };
    });

    expect(result.finalCtx.version).toBeGreaterThanOrEqual(2);
    expect(['COMPLETED', 'CANCELLED']).toContain(result.finalCtx.status);
    expect(result.logs.length).toBeLessThanOrEqual(1);
  });

  test('E2E-RACE-02: Voice x Cancel race prevents resurrection of cancelled context with zero side-effects', async ({ page }) => {
    await setupApp(page);

    const result = await page.evaluate(async () => {
      const vc = (window as any).__VOICE_CHANNEL__;
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const app = (window as any).__VOICE_DEMO_APP__;
      const identity = app.getIdentity();

      const ctx = dm.createContext('ORDER_PAYMENT', {}, ['paymentMethod'], 'order.payment.completed', {}, identity);

      await dm.cancelContext(ctx.contextId, identity);
      const voiceRes = await vc.handleIncomingVoice('картой', identity);
      const logs = dm.getExecutionLogs(identity);

      return { finalCtx: dm.getContext(ctx.contextId, identity), voiceRes, executionLogsCount: logs.length };
    });

    expect(result.finalCtx.status).toBe('CANCELLED');
    expect(result.finalCtx.slots.paymentMethod).toBeUndefined();
    expect(result.executionLogsCount).toBe(0); // Proves zero side effects on loser
  });

  test('E2E-RACE-03: Voice x TTL Expiry race maintains strict terminal isolation', async ({ page }) => {
    await setupApp(page);

    const result = await page.evaluate(async () => {
      const vc = (window as any).__VOICE_CHANNEL__;
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const app = (window as any).__VOICE_DEMO_APP__;
      const identity = app.getIdentity();

      const ctx = dm.createContext('ORDER_PAYMENT', {}, ['paymentMethod'], 'order.payment.completed', {}, identity);

      const [expRes, voiceRes] = await Promise.all([
        dm.expireContext(ctx.contextId, identity),
        vc.handleIncomingVoice('наличными', identity)
      ]);

      const logs = dm.getExecutionLogs(identity);
      return { finalCtx: dm.getContext(ctx.contextId, identity), executionLogsCount: logs.length };
    });

    expect(result.finalCtx.status).toBe('EXPIRED');
    expect(result.executionLogsCount).toBe(0);
  });

  test('E2E-RACE-04: Action completion x Declarative System Finish race with full queue lock', async ({ page }) => {
    await setupApp(page);

    const result = await page.evaluate(async () => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const app = (window as any).__VOICE_DEMO_APP__;
      const identity = app.getIdentity();

      const ctx = dm.createContext('ORDER_PAYMENT', { paymentMethod: 'CARD' }, ['paymentMethod'], 'order.payment.completed', {}, identity);
      const ex = dm.createExecution(ctx, identity);

      const [dispRes, sysRes] = await Promise.all([
        dm.dispatchAction(ex.executionId, { paymentMethod: 'CARD' }, identity),
        dm.handleSystemEvent(ctx.contextId, { type: 'EXTERNAL_FINISH', targetTransition: 'COMPLETE' }, identity)
      ]);

      return { finalCtx: dm.getContext(ctx.contextId, identity), dispRes, sysRes, logs: dm.getExecutionLogs(identity) };
    });

    expect(result.finalCtx.status).toBe('COMPLETED');
    expect(result.dispRes.status).toBe('SUCCEEDED');
    expect(result.finalCtx.version).toBeGreaterThanOrEqual(3);
    expect(result.logs.length).toBe(1);
  });

  test('E2E-RACE-05: Concurrent operations on 2 independent contexts execute without interference', async ({ page }) => {
    await setupApp(page);

    const result = await page.evaluate(async () => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const app = (window as any).__VOICE_DEMO_APP__;
      const identity = app.getIdentity();

      const ctx1 = dm.createContext('CTX_1', {}, ['slot1'], 'act.1', {}, identity);
      const ctx2 = dm.createContext('CTX_2', {}, ['slot2'], 'act.2', {}, identity);

      await Promise.all([
        dm.fillSlot('slot1', 'val1', ctx1.contextId, identity),
        dm.fillSlot('slot2', 'val2', ctx2.contextId, identity)
      ]);

      return {
        c1: dm.getContext(ctx1.contextId, identity),
        c2: dm.getContext(ctx2.contextId, identity)
      };
    });

    expect(result.c1.version).toBe(2);
    expect(result.c2.version).toBe(2);
    expect(result.c1.slots.slot1).toBe('val1');
    expect(result.c2.slots.slot2).toBe('val2');
  });

  test('E2E-RACE-06: Heavy concurrent operations on 3+ contexts remain isolated', async ({ page }) => {
    await setupApp(page);

    const result = await page.evaluate(async () => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const app = (window as any).__VOICE_DEMO_APP__;
      const identity = app.getIdentity();

      const ctxs = [
        dm.createContext('C1', {}, ['s1'], 'a1', {}, identity),
        dm.createContext('C2', {}, ['s2'], 'a2', {}, identity),
        dm.createContext('C3', {}, ['s3'], 'a3', {}, identity),
        dm.createContext('C4', {}, ['s4'], 'a4', {}, identity)
      ];

      await Promise.all(ctxs.map((c, i) => dm.fillSlot(`s${i+1}`, `val${i+1}`, c.contextId, identity)));

      return ctxs.map(c => dm.getContext(c.contextId, identity));
    });

    for (let i = 0; i < 4; i++) {
      expect(result[i].version).toBe(2);
      expect(result[i].slots[`s${i+1}`]).toBe(`val${i+1}`);
    }
  });

});
