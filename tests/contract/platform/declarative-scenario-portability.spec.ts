import { test, expect } from '@playwright/test';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel, type ScenarioSet } from '../../../src/platform/voice-channel';

test.describe('CONTRACT: SC-PLATFORM-001 Declarative Scenario Portability Suite', () => {

  const sessionUserA = { ownerId: 'user-portable-001', sessionId: 'session-portable-A' };
  const sessionUserB = { ownerId: 'user-portable-002', sessionId: 'session-portable-B' };

  let dm: DialogueStateManager;
  let vc: VoiceChannel;
  let dispatcherCalls: number;

  const scenarioSetA: ScenarioSet = {
    version: 1,
    id: 'scenario-portability-a',
    scenarios: [
      {
        id: 'select-item-a',
        intent: 'SELECT_ITEM',
        triggerPhrases: ['выбираю предмет а', 'хочу предмет'],
        requiredSlots: ['selectedItemId', 'confirmation'],
        slotExtractors: {
          selectedItemId: {
            type: 'string',
            rules: [
              { pattern: '\\b(предмет\\s*1|item-1)\\b', value: 'ITEM-1' },
              { pattern: '\\b(предмет\\s*2|item-2)\\b', value: 'ITEM-2' }
            ]
          },
          confirmation: {
            type: 'enum',
            rules: [
              { pattern: '\\b(да|подтверждаю)\\b', value: 'CONFIRMED' },
              { pattern: '\\b(нет|отказываюсь)\\b', value: 'REJECTED' }
            ]
          }
        },
        steps: [
          {
            kind: 'emit',
            event: {
              type: 'item.selection.completed',
              payload: {}
            }
          }
        ]
      }
    ]
  };

  const scenarioSetB: ScenarioSet = {
    version: 1,
    id: 'scenario-portability-b',
    scenarios: [
      {
        id: 'select-item-b',
        intent: 'SELECT_ITEM',
        triggerPhrases: ['choose item b', 'select item'],
        requiredSlots: ['selectedItemId', 'confirmation'],
        slotExtractors: {
          selectedItemId: {
            type: 'string',
            rules: [
              { pattern: '\\b(item-1|alpha)\\b', value: 'ITEM-1' },
              { pattern: '\\b(item-2|beta)\\b', value: 'ITEM-2' }
            ]
          },
          confirmation: {
            type: 'enum',
            rules: [
              { pattern: '\\b(confirm|confirmed)\\b', value: 'CONFIRMED' },
              { pattern: '\\b(reject|rejected)\\b', value: 'REJECTED' }
            ]
          }
        },
        steps: [
          {
            kind: 'emit',
            event: {
              type: 'item.selection.completed',
              payload: {}
            }
          }
        ]
      }
    ]
  };

  test.beforeEach(() => {
    dispatcherCalls = 0;
    dm = new DialogueStateManager({
      actionDispatcher: async (event, ctx, exec) => {
        dispatcherCalls++;
        return { status: 'SUCCEEDED', executionId: exec.executionId, attempt: exec.attempt };
      }
    });
    vc = new VoiceChannel(dm);
  });

  test('PORTABILITY-01: ScenarioSet A — selection -> «да» -> CONFIRMED & single execution', async () => {
    vc.registerScenarioSet(scenarioSetA);

    dm.createContext(
      'SELECT_ITEM',
      { selectedItemId: 'ITEM-1' },
      ['selectedItemId', 'confirmation'],
      'item.selection.completed',
      {},
      sessionUserA,
      'select-item-a'
    );

    const res = await vc.handleIncomingVoice('да', sessionUserA);

    expect(res.status).toBe('COMPLETED');
    expect(dm.getExecutionLogs(sessionUserA).length).toBe(1);
    expect(dispatcherCalls).toBe(1);
  });

  test('PORTABILITY-02: ScenarioSet A — selection -> «нет» -> REJECTED & 0 execution', async () => {
    vc.registerScenarioSet(scenarioSetA);

    dm.createContext(
      'SELECT_ITEM',
      { selectedItemId: 'ITEM-1' },
      ['selectedItemId', 'confirmation'],
      'item.selection.completed',
      {},
      sessionUserA,
      'select-item-a'
    );

    const res = await vc.handleIncomingVoice('нет', sessionUserA);

    expect(res.status).toBe('SELECTION_REJECTED');
    const ctx = dm.getActiveState(sessionUserA);
    expect(ctx?.status).toBe('WAITING_FOR_SLOT');
    expect(dm.getExecutionLogs(sessionUserA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('PORTABILITY-03: ScenarioSet B — selection -> «confirm» -> CONFIRMED & single execution', async () => {
    vc.registerScenarioSet(scenarioSetB);

    dm.createContext(
      'SELECT_ITEM',
      { selectedItemId: 'ITEM-2' },
      ['selectedItemId', 'confirmation'],
      'item.selection.completed',
      {},
      sessionUserA,
      'select-item-b'
    );

    const res = await vc.handleIncomingVoice('confirm', sessionUserA);

    expect(res.status).toBe('COMPLETED');
    expect(dm.getExecutionLogs(sessionUserA).length).toBe(1);
    expect(dispatcherCalls).toBe(1);
  });

  test('PORTABILITY-04: ScenarioSet B — selection -> «reject» -> REJECTED & 0 execution', async () => {
    vc.registerScenarioSet(scenarioSetB);

    dm.createContext(
      'SELECT_ITEM',
      { selectedItemId: 'ITEM-2' },
      ['selectedItemId', 'confirmation'],
      'item.selection.completed',
      {},
      sessionUserA,
      'select-item-b'
    );

    const res = await vc.handleIncomingVoice('reject', sessionUserA);

    expect(res.status).toBe('SELECTION_REJECTED');
    const ctx = dm.getActiveState(sessionUserA);
    expect(ctx?.status).toBe('WAITING_FOR_SLOT');
    expect(dm.getExecutionLogs(sessionUserA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('PORTABILITY-05: Отсутствие скрытой семантики (ScenarioSet B не реагирует на «да», ScenarioSet A — на «confirm»)', async () => {
    // 1. ScenarioSet B с русской фразой «да»
    vc.registerScenarioSet(scenarioSetB);
    dm.createContext(
      'SELECT_ITEM',
      { selectedItemId: 'ITEM-1' },
      ['selectedItemId', 'confirmation'],
      'item.selection.completed',
      {},
      sessionUserA,
      'select-item-b'
    );

    await vc.handleIncomingVoice('да', sessionUserA);
    expect(dm.getExecutionLogs(sessionUserA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);

    // 2. ScenarioSet A с английской фразой «confirm»
    const dm2 = new DialogueStateManager({
      actionDispatcher: async (event, ctx, exec) => {
        dispatcherCalls++;
        return { status: 'SUCCEEDED', executionId: exec.executionId, attempt: exec.attempt };
      }
    });
    const vc2 = new VoiceChannel(dm2);
    vc2.registerScenarioSet(scenarioSetA);
    dm2.createContext(
      'SELECT_ITEM',
      { selectedItemId: 'ITEM-1' },
      ['selectedItemId', 'confirmation'],
      'item.selection.completed',
      {},
      sessionUserA,
      'select-item-a'
    );

    await vc2.handleIncomingVoice('confirm', sessionUserA);
    expect(dm2.getExecutionLogs(sessionUserA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('PORTABILITY-06: Rejection -> replacement -> confirmation на ScenarioSet A', async () => {
    vc.registerScenarioSet(scenarioSetA);

    dm.createContext(
      'SELECT_ITEM',
      { selectedItemId: 'ITEM-1' },
      ['selectedItemId', 'confirmation'],
      'item.selection.completed',
      {},
      sessionUserA,
      'select-item-a'
    );

    await vc.handleIncomingVoice('нет', sessionUserA);
    await vc.handleIncomingVoice('предмет 2', sessionUserA);
    await vc.handleIncomingVoice('да', sessionUserA);

    const logs = dm.getExecutionLogs(sessionUserA);
    expect(logs.length).toBe(1);
    expect(dispatcherCalls).toBe(1);
    expect(logs[0].payload.selectedItemId).toBe('ITEM-2');
  });

  test('PORTABILITY-07: Scenario isolation — активный сценарий использует строго свои правила экстракции', async () => {
    vc.registerScenarioSet(scenarioSetA);
    vc.registerScenarioSet(scenarioSetB);

    // Контекст со сценарием A
    dm.createContext(
      'SELECT_ITEM',
      { selectedItemId: 'ITEM-1' },
      ['selectedItemId', 'confirmation'],
      'item.selection.completed',
      {},
      sessionUserA,
      'select-item-a'
    );

    // Английское подтверждение не должно сработать в контексте сценария A
    await vc.handleIncomingVoice('confirm', sessionUserA);
    expect(dm.getExecutionLogs(sessionUserA).length).toBe(0);

    // Русское подтверждение срабатывает
    await vc.handleIncomingVoice('да', sessionUserA);
    expect(dm.getExecutionLogs(sessionUserA).length).toBe(1);
  });

  test('PORTABILITY-08: Ownership isolation', async () => {
    vc.registerScenarioSet(scenarioSetA);

    const ctx = dm.createContext(
      'SELECT_ITEM',
      { selectedItemId: 'ITEM-1' },
      ['selectedItemId', 'confirmation'],
      'item.selection.completed',
      {},
      sessionUserA,
      'select-item-a'
    );

    const foreignConfirm = await dm.fillSlot('confirmation', 'CONFIRMED', ctx.contextId, sessionUserB);
    expect(foreignConfirm.success).toBe(false);
    expect(foreignConfirm.error).toBe('CONTEXT_ACCESS_DENIED');
  });

});
