import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import * as fs from 'fs';
import * as path from 'path';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel, type ScenarioSet, type ScenarioDefinition } from '../../../src/platform/voice-channel';
import {
  DialogueEngine,
  type DialogueInput
} from '../../../src/platform/dialogue-channel';
import { TelegramBotAdapter, MockTelegramClient } from '../../../src/platform/telegram-bot-adapter';
import { TelegramVoiceTransport } from '../../../src/platform/telegram-voice-transport';
import { MockSTTProvider } from '../../../src/platform/stt-provider';

// Mock Web Adapter without Scenario parameter
class MockWebAdapter {
  constructor(private engine: DialogueEngine) {}

  async submit(input: DialogueInput, identity: { ownerId: string; sessionId: string }) {
    return this.engine.processInput(input, identity);
  }
}

test.describe('CONTRACT: SC-INTEGRATION-005 Generic Dialogue Scenario Routing & Session Binding Suite', () => {

  const sessionUser = { ownerId: 'user-sr-501', sessionId: 'sess-sr-501' };

  let dm: DialogueStateManager;
  let vc: VoiceChannel;
  let engine: DialogueEngine;
  let nannyScenarioSet: ScenarioSet;

  test.beforeEach(() => {
    dm = new DialogueStateManager();
    vc = new VoiceChannel(dm);

    const scenarioRaw = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scenario-nanny-order.json'), 'utf8');
    nannyScenarioSet = JSON.parse(scenarioRaw);
    vc.registerScenarioSet(nannyScenarioSet);

    engine = new DialogueEngine(dm, vc);
  });

  test('SR-01: New Text -> Scenario Resolution (resolves order-nanny and fills date)', async () => {
    const res = await engine.processInput({
      modality: 'text',
      raw_input: 'нужна няня завтра'
    }, sessionUser);

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx).toBeDefined();
    expect(ctx?.scenarioId).toBe('order-nanny');
    expect(ctx?.slots.date).toBe('завтра');
  });

  test('SR-02: New Voice -> Scenario Resolution (resolves order-nanny from transcript)', async () => {
    const res = await engine.processInput({
      modality: 'voice',
      transcript: 'нужна няня завтра'
    }, sessionUser);

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.scenarioId).toBe('order-nanny');
    expect(ctx?.slots.date).toBe('завтра');
  });

  test('SR-03: Existing Context ignores new Scenario matching and continues active scenario', async () => {
    // 1. First message sets order-nanny
    await engine.processInput({ modality: 'text', raw_input: 'нужна няня завтра' }, sessionUser);
    expect(dm.getActiveState(sessionUser)?.scenarioId).toBe('order-nanny');

    // Register a second scenario that could potentially match other words
    const secondSet: ScenarioSet = {
      version: 1,
      id: 'other-set',
      scenarios: [{
        id: 'other-scenario',
        intent: 'OTHER_INTENT',
        triggerPhrases: ['в три'],
        requiredSlots: ['time']
      }]
    };
    vc.registerScenarioSet(secondSet);

    // 2. Second message sends "в три часа" -> must stay in order-nanny context and fill start_time!
    await engine.processInput({ modality: 'text', raw_input: 'в три' }, sessionUser);

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.scenarioId).toBe('order-nanny');
    expect(ctx?.slots.start_time).toBe('15:00');
  });

  test('SR-04: Button uses Context Scenario without adapter passing scenario', async () => {
    // Open context
    await engine.processInput({ modality: 'text', raw_input: 'нужна няня завтра' }, sessionUser);

    // Send button payload
    await engine.processInput({
      modality: 'button',
      payload: {
        slotName: 'start_time',
        slotValue: '15:00'
      }
    }, sessionUser);

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.scenarioId).toBe('order-nanny');
    expect(ctx?.slots.start_time).toBe('15:00');
  });

  test('SR-05: Button without Context returns SCENARIO_NOT_FOUND (no guesswork)', async () => {
    const freshUser = { ownerId: 'fresh-user-5', sessionId: 'fresh-sess-5' };

    const res = await engine.processInput({
      modality: 'button',
      payload: {
        slotName: 'selected_nanny',
        slotValue: 'xyz-42'
      }
    }, freshUser);

    expect(res.status).toBe('SCENARIO_NOT_FOUND');
    expect(dm.getActiveState(freshUser)).toBeNull();
  });

  test('SR-06: Independent Service Scenario routes correctly without nanny terminology', async () => {
    const serviceSet: ScenarioSet = {
      version: 1,
      id: 'service-set',
      scenarios: [{
        id: 'book-service',
        intent: 'BOOK_SERVICE',
        triggerPhrases: ['заказать услугу', 'book service'],
        requiredSlots: ['selected_service', 'confirmation'],
        candidateBinding: {
          targetSlot: 'selected_service',
          idField: 'serviceId',
          labelField: 'title'
        }
      }]
    };
    vc.registerScenarioSet(serviceSet);

    const userS = { ownerId: 'u-serv-5', sessionId: 's-serv-5' };
    const res = await engine.processInput({
      modality: 'text',
      raw_input: 'заказать услугу'
    }, userS);

    const ctx = dm.getActiveState(userS);
    expect(ctx?.scenarioId).toBe('book-service');
  });

  test('SR-07: Duplicate trigger registration is rejected instead of creating runtime ambiguity', async () => {
    const ambiguousSet: ScenarioSet = {
      version: 1,
      id: 'ambiguous-set',
      scenarios: [
        {
          id: 'sc-amb-1',
          intent: 'INTENT_1',
          priority: 10,
          triggerPhrases: ['помощь']
        },
        {
          id: 'sc-amb-2',
          intent: 'INTENT_2',
          priority: 10,
          triggerPhrases: ['помощь'],
          ambiguityPrompt: { template: 'Уточните, какая помощь нужна' }
        }
      ]
    };

    expect(() => vc.registerScenarioSet(ambiguousSet))
      .toThrow(/CONTRACT_VIOLATION.*Trigger or alias collision/);
    expect(vc.getActiveScenarioSetId()).toBe(nannyScenarioSet.id);
  });

  test('SR-08: Priority Resolution selects scenario with highest priority via VoiceChannel.resolveIntent', async () => {
    const prioritySet: ScenarioSet = {
      version: 1,
      id: 'priority-set',
      scenarios: [
        {
          id: 'low-prio-sc',
          intent: 'LOW_PRIO',
          priority: 1,
          triggerPhrases: ['приветствие']
        },
        {
          id: 'high-prio-sc',
          intent: 'HIGH_PRIO',
          priority: 99,
          triggerPhrases: ['приветствие']
        }
      ]
    };
    vc.registerScenarioSet(prioritySet);

    const userPrio = { ownerId: 'u-prio', sessionId: 's-prio' };
    await engine.processInput({ modality: 'text', raw_input: 'приветствие' }, userPrio);

    const ctx = dm.getActiveState(userPrio);
    expect(ctx?.scenarioId).toBe('high-prio-sc');
  });

  test('SR-09: No Match returns generic SCENARIO_NOT_FOUND', async () => {
    const userNo = { ownerId: 'u-no', sessionId: 's-no' };
    const res = await engine.processInput({ modality: 'text', raw_input: 'расскажи анекдот' }, userNo);

    expect(res.status).toBe('SCENARIO_NOT_FOUND');
    expect(dm.getActiveState(userNo)).toBeNull();
  });

  test('SR-10: Telegram Adapter handleUpdate does not receive Scenario parameter', async () => {
    const tgClient = new MockTelegramClient();
    const mockSTT = new MockSTTProvider();
    const voiceTransport = new TelegramVoiceTransport(mockSTT);
    const botAdapter = new TelegramBotAdapter(engine, voiceTransport, tgClient);

    const tgUser = { id: 888 };
    const tgChat = { id: 999 };
    const identity = { ownerId: '888', sessionId: '999' };

    // Call handleUpdate without any scenario argument!
    await botAdapter.handleUpdate({
      message: { from: tgUser, chat: tgChat, text: 'нужна няня завтра' }
    });

    const ctx = dm.getActiveState(identity);
    expect(ctx?.scenarioId).toBe('order-nanny');
    expect(ctx?.slots.date).toBe('завтра');
  });

  test('SR-11: Web Adapter does not receive Scenario parameter', async () => {
    const webAdapter = new MockWebAdapter(engine);
    const webUser = { ownerId: 'web-501', sessionId: 'tab-501' };

    await webAdapter.submit({ modality: 'text', raw_input: 'нужна няня завтра' }, webUser);

    const ctx = dm.getActiveState(webUser);
    expect(ctx?.scenarioId).toBe('order-nanny');
    expect(ctx?.slots.date).toBe('завтра');
  });

  test('SR-12: Same Context across modalities without passing Scenario on each step', async () => {
    const userMix = { ownerId: 'u-mix-5', sessionId: 's-mix-5' };

    // 1. Text
    await engine.processInput({ modality: 'text', raw_input: 'нужна няня завтра' }, userMix);
    // 2. Button
    await engine.processInput({ modality: 'button', payload: { slotName: 'start_time', slotValue: '15:00' } }, userMix);
    // 3. Voice
    await engine.processInput({ modality: 'voice', transcript: 'до восьми' }, userMix);
    // 4. Text
    await engine.processInput({ modality: 'text', raw_input: 'центр' }, userMix);

    expect(dm.listContexts(userMix).length).toBe(1);
    const ctx = dm.getActiveState(userMix);
    expect(ctx?.scenarioId).toBe('order-nanny');
    expect(ctx?.slots.date).toBe('завтра');
    expect(ctx?.slots.start_time).toBe('15:00');
    expect(ctx?.slots.end_time).toBe('20:00');
    expect(ctx?.slots.location).toBe('Центр');
  });

  test('SR-13: Scenario persistence — ctx.scenarioId remains permanent source of truth', async () => {
    await engine.processInput({ modality: 'text', raw_input: 'нужна няня завтра' }, sessionUser);
    const ctxInitial = dm.getActiveState(sessionUser);
    expect(ctxInitial?.scenarioId).toBe('order-nanny');

    // Follow-up message
    await engine.processInput({ modality: 'text', raw_input: 'до восьми' }, sessionUser);
    const ctxFollowUp = dm.getActiveState(sessionUser);
    expect(ctxFollowUp?.scenarioId).toBe('order-nanny');
    expect(ctxFollowUp?.contextId).toBe(ctxInitial?.contextId);
  });

  // Architectural Static Checks (AT-09 .. AT-13)
  test('AT-09: telegram-bot-adapter.ts does NOT contain resolveIntent, resolveScenario, registerScenarioSet', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-bot-adapter.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain('resolveIntent');
    expect(content).not.toContain('resolveScenario');
    expect(content).not.toContain('registerScenarioSet');
  });

  test('AT-10: telegram-dialogue-adapter.ts does NOT contain resolveIntent, resolveScenario, registerScenarioSet', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-dialogue-adapter.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain('resolveIntent');
    expect(content).not.toContain('resolveScenario');
    expect(content).not.toContain('registerScenarioSet');
  });

  test('AT-11: MockWebAdapter does NOT contain Scenario selection logic', () => {
    const adapterCode = MockWebAdapter.toString();
    expect(adapterCode).not.toContain('resolveIntent');
    expect(adapterCode).not.toContain('ScenarioDefinition');
  });

  test('AT-12: DialogueEngine uses existing VoiceChannel.resolveIntent and does not implement custom trigger matching', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/dialogue-channel.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('this.vc.resolveIntent');
    expect(content).not.toContain('triggerPhrases');
    expect(content).not.toContain('aliases');
  });

  test('AT-13: Adapters handleUpdate does NOT require ScenarioDefinition parameter', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-bot-adapter.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    // Must allow calling handleUpdate without scenario
    expect(content).toMatch(/handleUpdate\(\s*update:\s*TelegramUpdate,\s*optionalScenario\?:/);
  });

});
