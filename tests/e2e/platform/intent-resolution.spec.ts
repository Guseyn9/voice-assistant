import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-platform-014-intent-slot-resolution.json');

test.describe('E2E: PLATFORM-014 Intent Resolution & Slot Ambiguity Suite', () => {

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
    expect(activeSetId).toBe('scenario-set-platform-014-intent-slot-resolution');
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

  test('E2E-INTENT-01: Explicit single utterance creates context and executes action with exact payload', async ({ page }) => {
    await setupApp(page);

    const res = await emitVoice(page, 'экспресс заказ 1001', sessionA);
    expect(res.status).toBe('COMPLETED');
    expect(res.intent).toBe('ORDER_EXPRESS');

    const logs = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs(id), sessionA);
    expect(logs.length).toBe(1);
    expect(logs[0].event.type).toBe('order.express.created');
    expect(logs[0].event.payload).toEqual({ orderId: 1001 });
  });

  test('E2E-INTENT-02: Ambiguous intent phrase returns AMBIGUOUS_INTENT with zero executions', async ({ page }) => {
    await setupApp(page);

    // Register temporary conflicting scenarios
    await page.evaluate(() => {
      (window as any).__VOICE_CHANNEL__.registerScenarioSet({
        version: 2,
        id: 'temp-amb-set',
        name: 'Temp Amb Set',
        scenarios: [
          { id: 'sc-1', name: 'S1', activation: { type: 'voice', value: 'voice.order-taxi' }, priority: 10, intent: 'T1', steps: [{ kind: 'emit', event: { type: 't1', payload: {} } }] },
          { id: 'sc-2', name: 'S2', activation: { type: 'voice', value: 'voice.order-food' }, priority: 10, intent: 'T2', steps: [{ kind: 'emit', event: { type: 't2', payload: {} } }] }
        ]
      });
    });

    const res = await emitVoice(page, 'order', sessionA);
    expect(res.status).toBe('AMBIGUOUS_INTENT');
    expect(res.candidateScenarioIds).toEqual(['sc-1', 'sc-2']);

    const logs = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs(id), sessionA);
    expect(logs.length).toBe(0);
  });

  test('E2E-INTENT-03: Priority resolution selects highest priority scenario deterministically', async ({ page }) => {
    await setupApp(page);

    await page.evaluate(() => {
      (window as any).__VOICE_CHANNEL__.registerScenarioSet({
        version: 2,
        id: 'temp-prio-set',
        name: 'Temp Prio Set',
        scenarios: [
          { id: 'sc-normal', name: 'Normal', activation: { type: 'voice', value: 'voice.ride' }, priority: 10, intent: 'RIDE_NORMAL', steps: [{ kind: 'emit', event: { type: 'ride.normal', payload: {} } }] },
          { id: 'sc-vip', name: 'VIP', activation: { type: 'voice', value: 'voice.ride-vip' }, priority: 100, intent: 'RIDE_VIP', steps: [{ kind: 'emit', event: { type: 'ride.vip', payload: {} } }] }
        ]
      });
    });

    const res = await emitVoice(page, 'ride', sessionA);
    expect(res.status).toBe('COMPLETED');
    expect(res.intent).toBe('RIDE_VIP');

    const logs = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs(id), sessionA);
    expect(logs.length).toBe(1);
    expect(logs[0].event.type).toBe('ride.vip');
  });

  test('E2E-SLOT-01: Competing slot extractors with equal priority return AMBIGUOUS_SLOT and 0 executions', async ({ page }) => {
    await setupApp(page);

    await page.evaluate(() => {
      (window as any).__VOICE_CHANNEL__.registerScenarioSet({
        version: 2,
        id: 'temp-slot-amb-set',
        name: 'Slot Amb Set',
        scenarios: [
          {
            id: 'sc-slot',
            name: 'Slot',
            activation: { type: 'voice', value: 'voice.fill' },
            intent: 'FILL_INTENT',
            requiredSlots: ['city'],
            slotExtractors: {
              city: { type: 'string', priority: 50 },
              street: { type: 'string', priority: 50 }
            },
            steps: [{ kind: 'emit', event: { type: 'fill.done', payload: {} } }]
          }
        ]
      });
    });

    await emitVoice(page, 'fill', sessionA);
    const fillRes = await emitVoice(page, 'москва', sessionA);

    expect(fillRes.status).toBe('AMBIGUOUS_SLOT');
    expect(fillRes.candidates.length).toBe(2);

    const logs = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs(id), sessionA);
    expect(logs.length).toBe(0);
  });

  test('E2E-SLOT-02: Slot priority deterministically resolves competing extractors', async ({ page }) => {
    await setupApp(page);

    await page.evaluate(() => {
      (window as any).__VOICE_CHANNEL__.registerScenarioSet({
        version: 2,
        id: 'temp-slot-prio-set',
        name: 'Slot Prio Set',
        scenarios: [
          {
            id: 'sc-slot-prio',
            name: 'Slot Prio',
            activation: { type: 'voice', value: 'voice.deliver' },
            intent: 'DELIVER_INTENT',
            requiredSlots: ['city'],
            slotExtractors: {
              city: { type: 'string', priority: 100 },
              street: { type: 'string', priority: 50 }
            },
            steps: [{ kind: 'emit', event: { type: 'deliver.done', payload: { city: '{{slots.city}}' } } }]
          }
        ]
      });
    });

    await emitVoice(page, 'deliver', sessionA);
    const fillRes = await emitVoice(page, 'ташкент', sessionA);

    expect(fillRes.status).toBe('COMPLETED');
    expect(fillRes.slots.city).toBe('ташкент');

    const logs = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs(id), sessionA);
    expect(logs.length).toBe(1);
    expect(logs[0].event.payload.city).toBe('ташкент');
  });

  test('E2E-REGISTRY-01: Failed registry update leaves previously loaded ScenarioSet operational', async ({ page }) => {
    await setupApp(page);

    const activeBefore = await page.evaluate(() => (window as any).__VOICE_CHANNEL__.getActiveScenarioSetId());
    expect(activeBefore).toBe('scenario-set-platform-014-intent-slot-resolution');

    // Attempt invalid registration
    await page.evaluate(() => {
      try {
        (window as any).__VOICE_CHANNEL__.registerScenarioSet({
          version: 2,
          id: 'invalid-dup-set',
          name: 'Invalid',
          scenarios: [
            { id: 'dup-1', name: 'D1', activation: { type: 'voice', value: 'voice.same' }, intent: 'I1', steps: [{ kind: 'emit', event: { type: 'e1', payload: {} } }] },
            { id: 'dup-1', name: 'D2', activation: { type: 'voice', value: 'voice.other' }, intent: 'I2', steps: [{ kind: 'emit', event: { type: 'e2', payload: {} } }] }
          ]
        });
      } catch (e) {
        // Expected CONTRACT_VIOLATION
      }
    });

    const activeAfter = await page.evaluate(() => (window as any).__VOICE_CHANNEL__.getActiveScenarioSetId());
    expect(activeAfter).toBe('scenario-set-platform-014-intent-slot-resolution');
  });

  test('E2E-REGISTRY-02: Session isolation ensures foreign contexts are excluded from resolution', async ({ page }) => {
    await setupApp(page);

    await emitVoice(page, 'экспресс заказ 1001', sessionA);
    await emitVoice(page, 'экспресс заказ 2001', sessionB);

    const logsA = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs(id), sessionA);
    const logsB = await page.evaluate((id) => (window as any).__DIALOGUE_MANAGER__.getExecutionLogs(id), sessionB);

    expect(logsA.length).toBe(1);
    expect(logsA[0].event.payload.orderId).toBe(1001);

    expect(logsB.length).toBe(1);
    expect(logsB[0].event.payload.orderId).toBe(2001);
  });

});
