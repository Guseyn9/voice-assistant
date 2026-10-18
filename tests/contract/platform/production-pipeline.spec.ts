import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel, ScenarioSet } from '../../../src/platform/voice-channel';
import * as fs from 'fs';
import * as path from 'path';

const scenarioPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scenario-platform-012-production-pipeline.json');
const rawContent = fs.readFileSync(scenarioPath, 'utf-8');
const scenarioSet: ScenarioSet = JSON.parse(rawContent);

test.describe('CONTRACT: PLATFORM-012 Production Pipeline Suite', () => {

  const identity = { ownerId: 'platform-012-test', sessionId: 'platform-012-session' };

  test('CONTRACT-01: VoiceChannel registers ScenarioSet and exposes activeScenarioSetId', async () => {
    const dm = new DialogueStateManager();
    const channel = new VoiceChannel(dm);
    channel.registerScenarioSet(scenarioSet);

    expect(channel.getActiveScenarioSetId()).toBe('scenario-set-platform-012-production-pipeline');
  });

  test('CONTRACT-02: Action Dispatch boundary invokes real onActionDispatch callback upon context completion', async () => {
    const dispatchedEvents: any[] = [];
    const dm = new DialogueStateManager({
      actionDispatcher: async (event, ctx, execution) => {
        dispatchedEvents.push({ event, contextId: ctx.contextId });
        return { status: 'SUCCEEDED', executionId: execution.executionId, attempt: execution.attempt };
      }
    });
    const channel = new VoiceChannel(dm);
    channel.registerScenarioSet(scenarioSet);

    await channel.handleIncomingVoice('Прими заказ 1001', identity);
    await channel.handleIncomingVoice('Картой', identity);

    expect(dispatchedEvents.length).toBe(1);
    expect(dispatchedEvents[0].event.type).toBe('driver.order.accepted');
    expect(dispatchedEvents[0].event.payload).toEqual({ orderId: 1001, payment: 'card' });
  });

  test('CONTRACT-03: Auto-Expiry Scheduler automatically transitions context to EXPIRED after TTL without manual calls', async () => {
    // 50ms TTL for fast contract verification
    const dm = new DialogueStateManager({ defaultTtlMs: 50, enableAutoExpiryScheduler: true });
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);

    expect(ctx.status).toBe('WAITING_FOR_SLOT');

    // Wait for auto-expiry timer
    await new Promise(resolve => setTimeout(resolve, 80));

    const expiredCtx = dm.getContext(ctx.contextId, identity);
    expect(expiredCtx?.status).toBe('EXPIRED');
  });

  test('CONTRACT-04: Strict capacity policy rejects new context when maxActiveContexts is exceeded', async () => {
    const dm = new DialogueStateManager({ maxActiveContexts: 1 });
    dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);

    expect(() => {
      dm.createContext('ACCEPT_ORDER', { orderId: 1002 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);
    }).toThrow(/REJECT_NEW_CONTEXT/);
  });

  test('CONTRACT-05: Strict cancellation with no domain execution and pure cancel handling', async () => {
    const dm = new DialogueStateManager();
    const channel = new VoiceChannel(dm);
    channel.registerScenarioSet(scenarioSet);

    await channel.handleIncomingVoice('Прими заказ 1001', identity);
    const cancelRes = await channel.handleIncomingVoice('Отмена', identity);

    expect(cancelRes).toMatchObject({ success: true, data: true });
    const ctx = dm.listContexts(identity)[0];
    expect(ctx.status).toBe('CANCELLED');
    expect(dm.getExecutionLogs(identity).length).toBe(0);
  });

  test('CONTRACT-06: Strict Ambiguity prompt template enforcement without fallback values', async () => {
    const dm = new DialogueStateManager();
    const channel = new VoiceChannel(dm);
    channel.registerScenarioSet(scenarioSet);

    await channel.handleIncomingVoice('Прими заказ 1001', identity);
    await channel.handleIncomingVoice('Прими заказ 1002', identity);

    const ambResult = await channel.handleIncomingVoice('Картой', identity);
    expect(ambResult.status).toBe('AMBIGUOUS_CONTEXT');
    expect(ambResult.clarificationPrompt).toContain('1001');
    expect(ambResult.clarificationPrompt).toContain('1002');
  });

});
