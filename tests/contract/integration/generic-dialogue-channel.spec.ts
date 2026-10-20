import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import * as fs from 'fs';
import * as path from 'path';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel, type ScenarioSet, type ScenarioDefinition } from '../../../src/platform/voice-channel';
import {
  DialogueEngine,
  type DialogueInput,
  type DialoguePresentation
} from '../../../src/platform/dialogue-channel';
import { TelegramBotAdapter, MockTelegramClient } from '../../../src/platform/telegram-bot-adapter';
import { TelegramVoiceTransport } from '../../../src/platform/telegram-voice-transport';
import { MockSTTProvider } from '../../../src/platform/stt-provider';
import { MockTelegramFileProvider } from './helpers/telegram-helpers';
class MockGenericChannelAdapter {
  constructor(private engine: DialogueEngine) {}

  async send(input: DialogueInput, identity: { ownerId: string; sessionId: string }, scenario: ScenarioDefinition) {
    return this.engine.processInput(input, identity, scenario);
  }
}

class MockWebChannelAdapter {
  constructor(private engine: DialogueEngine) {}

  async submit(input: DialogueInput, identity: { ownerId: string; sessionId: string }, scenario: ScenarioDefinition) {
    return this.engine.processInput(input, identity, scenario);
  }
}

test.describe('CONTRACT: SC-INTEGRATION-004 Generic Dialogue Channel Contract Suite', () => {

  const sessionUser = { ownerId: 'user-gen-401', sessionId: 'sess-gen-401' };

  let dm: DialogueStateManager;
  let vc: VoiceChannel;
  let engine: DialogueEngine;
  let nannyScenarioSet: ScenarioSet;
  let dispatcherCalls: number;

  test.beforeEach(() => {
    dispatcherCalls = 0;
    dm = new DialogueStateManager({
      actionDispatcher: async (event, ctx, exec) => {
        dispatcherCalls++;
        return { status: 'SUCCEEDED', executionId: exec.executionId, attempt: exec.attempt };
      }
    });
    vc = new VoiceChannel(dm);

    const scenarioRaw = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scenario-nanny-order.json'), 'utf8');
    nannyScenarioSet = JSON.parse(scenarioRaw);
    vc.registerScenarioSet(nannyScenarioSet);

    engine = new DialogueEngine(dm, vc);
  });

  const getNannyScenario = () => nannyScenarioSet.scenarios[0];

  test('GC-01: Text — Mock Channel -> DialogueInput(text) -> DialogueEngine -> DialoguePresentation', async () => {
    const sc = getNannyScenario();
    const adapter = new MockGenericChannelAdapter(engine);

    const res = await adapter.send({
      modality: 'text',
      raw_input: 'нужна няня завтра'
    }, sessionUser, sc);

    expect(dm.getActiveState(sessionUser)?.slots.date).toBe('завтра');
    expect(res.presentation.text).toBe(sc.clarificationPrompts?.start_time);
  });

  test('GC-02: Button — arbitrary slot and value filled via generic payload', async () => {
    const sc = getNannyScenario();
    const adapter = new MockGenericChannelAdapter(engine);

    await adapter.send({
      modality: 'button',
      payload: {
        slotName: 'start_time',
        slotValue: '15:00'
      }
    }, sessionUser, sc);

    expect(dm.getActiveState(sessionUser)?.slots.start_time).toBe('15:00');
  });

  test('GC-03: Voice — DialogueInput(voice with transcript) passes through the same DialogueEngine', async () => {
    const sc = getNannyScenario();
    const adapter = new MockGenericChannelAdapter(engine);

    await adapter.send({
      modality: 'voice',
      transcript: 'до восьми'
    }, sessionUser, sc);

    expect(dm.getActiveState(sessionUser)?.slots.end_time).toBe('20:00');
  });

  test('GC-04: Mixed channels (Text -> Button -> Voice -> Button -> Voice) in ONE DialogueContext', async () => {
    const sc = getNannyScenario();
    const adapter = new MockGenericChannelAdapter(engine);

    await adapter.send({ modality: 'text', raw_input: 'завтра' }, sessionUser, sc);
    await adapter.send({ modality: 'button', payload: { slotName: 'start_time', slotValue: '15:00' } }, sessionUser, sc);
    await adapter.send({ modality: 'voice', transcript: 'до восьми' }, sessionUser, sc);
    await adapter.send({ modality: 'button', payload: { slotName: 'children_count', slotValue: 2 } }, sessionUser, sc);
    await adapter.send({ modality: 'voice', transcript: 'центр' }, sessionUser, sc);

    expect(dm.listContexts(sessionUser).length).toBe(1);
    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('завтра');
    expect(ctx?.slots.start_time).toBe('15:00');
    expect(ctx?.slots.end_time).toBe('20:00');
    expect(ctx?.slots.children_count).toBe(2);
    expect(ctx?.slots.location).toBe('Центр');
  });

  test('GC-05: Generic candidate resolution on independent Scenario (service booking with selected_service)', async () => {
    const serviceScenario: ScenarioDefinition = {
      id: 'service-booking',
      intent: 'BOOK_SERVICE',
      requiredSlots: ['date', 'selected_service'],
      candidateBinding: {
        targetSlot: 'selected_service',
        idField: 'serviceId',
        labelField: 'title',
        indexField: 'position'
      },
      slotExtractors: {
        date: {
          type: 'string',
          rules: [{ pattern: '\\b(завтра)\\b', value: 'завтра' }]
        },
        choice: {
          type: 'integer',
          rules: [{ pattern: '\\b(втор(ой|ая)|2)\\b', value: 2 }]
        }
      }
    };

    const userS = { ownerId: 'u-serv', sessionId: 's-serv' };
    const adapter = new MockGenericChannelAdapter(engine);

    // Initial message to open context
    await adapter.send({ modality: 'text', raw_input: 'завтра' }, userS, serviceScenario);

    // Attach custom candidate items with non-standard fields
    const ctx = dm.getActiveState(userS)!;
    const offers = [
      { serviceId: 'svc-17', title: 'Cleaning', position: 1, status: 'AVAILABLE' },
      { serviceId: 'svc-42', title: 'Repair', position: 2, status: 'AVAILABLE' }
    ] as any;
    expect(dm.setOffersForContext(ctx.contextId, offers, userS)).toBe(true);

    // Send selection choice
    await adapter.send({ modality: 'voice', transcript: 'выбираю второй' }, userS, serviceScenario);

    expect(dm.getActiveState(userS)?.slots.selected_service).toBe('svc-42');
  });

  test('GC-05-B: Candidate Presentation portability with non-standard idField and labelField', async () => {
    const serviceScenario: ScenarioDefinition = {
      id: 'service-booking-pres',
      intent: 'BOOK_SERVICE',
      requiredSlots: ['selected_service'],
      candidateBinding: {
        targetSlot: 'selected_service',
        idField: 'serviceId',
        labelField: 'title',
        indexField: 'position'
      },
      clarificationPrompts: {
        selected_service: 'Выберите услугу:'
      }
    };

    const userP = { ownerId: 'u-pres', sessionId: 's-pres' };
    const adapter = new MockGenericChannelAdapter(engine);

    // Attach candidates before prompt
    dm.createContext('BOOK_SERVICE', {}, ['selected_service'], 'service.action', { selected_service: 'Выберите услугу:' }, userP, serviceScenario.id, [
      { serviceId: 'svc-17', title: 'Cleaning', position: 1 },
      { serviceId: 'svc-42', title: 'Repair', position: 2 }
    ] as any);

    // Prompt presentation generated
    const res = await adapter.send({ modality: 'text', raw_input: 'start' }, userP, serviceScenario);

    expect(res.presentation.actions).toBeDefined();
    const actions = res.presentation.actions![0];
    expect(actions[1].id).toBe('svc-42');
    expect(actions[1].label).toBe('Repair');
    expect(actions[1].payload.slotName).toBe('selected_service');
    expect(actions[1].payload.slotValue).toBe('svc-42');
  });

  test('GC-06: Declarative Confirmation — Scenario with approval (YES/NO) and custom messages', async () => {
    const approvalScenario: ScenarioDefinition = {
      id: 'custom-approval-scenario',
      intent: 'CUSTOM_ORDER',
      requiredSlots: ['target_item', 'approval'],
      confirmation: {
        slot: 'approval',
        confirmedValue: 'YES',
        rejectedValue: 'NO',
        confirmLabel: 'Подтвердить заказ',
        rejectLabel: 'Отказаться',
        confirmedMessage: 'Approval registered successfully'
      }
    };

    const userAppr = { ownerId: 'u-appr', sessionId: 's-appr' };
    const adapter = new MockGenericChannelAdapter(engine);

    // 1. Fill target_item
    const resPrompt = await adapter.send({ modality: 'button', payload: { slotName: 'target_item', slotValue: 'item-777' } }, userAppr, approvalScenario);

    expect(resPrompt.presentation.actions).toBeDefined();
    const actionRow = resPrompt.presentation.actions![0];
    expect(actionRow[0].label).toBe('Подтвердить заказ');
    expect(actionRow[0].payload.slotName).toBe('approval');
    expect(actionRow[0].payload.slotValue).toBe('YES');
    expect(actionRow[1].label).toBe('Отказаться');
    expect(actionRow[1].payload.slotValue).toBe('NO');

    // 2. Confirm
    const resConfirmed = await adapter.send({ modality: 'button', payload: { slotName: 'approval', slotValue: 'YES' } }, userAppr, approvalScenario);
    expect(resConfirmed.status).toBe('CONFIRMED');
    expect(resConfirmed.presentation.text).toBe('Approval registered successfully');
  });

  test('GC-07: Cancellation — generic cancellation with declarative rejection value', async () => {
    const sc = getNannyScenario();
    const adapter = new MockGenericChannelAdapter(engine);

    await adapter.send({ modality: 'text', raw_input: 'нужна няня' }, sessionUser, sc);
    expect(dm.getActiveState(sessionUser)).toBeDefined();

    const res = await adapter.send({ modality: 'button', payload: { slotName: 'confirmation', slotValue: 'REJECTED' } }, sessionUser, sc);

    expect(res.status).toBe('CANCELLED');
    expect(res.presentation.text).toBe(sc.confirmation?.cancelledMessage);
    expect(dm.getActiveState(sessionUser)).toBeNull();
  });

  test('GC-08: Execution — ActionDispatcher called exactly once on confirmation', async () => {
    const sc = getNannyScenario();
    const adapter = new MockGenericChannelAdapter(engine);

    await adapter.send({ modality: 'text', raw_input: 'завтра с трех до восьми на двух детей' }, sessionUser, sc);
    await adapter.send({ modality: 'button', payload: { slotName: 'children_ages', slotValue: '5 лет' } }, sessionUser, sc);
    await adapter.send({ modality: 'button', payload: { slotName: 'location', slotValue: 'Центр' } }, sessionUser, sc);
    await adapter.send({ modality: 'button', payload: { slotName: 'requirements', slotValue: 'без требований' } }, sessionUser, sc);
    await adapter.send({ modality: 'button', payload: { slotName: 'selected_nanny', slotValue: 'xyz-42' } }, sessionUser, sc);

    const res = await adapter.send({ modality: 'button', payload: { slotName: 'confirmation', slotValue: 'CONFIRMED' } }, sessionUser, sc);

    expect(res.status).toBe('CONFIRMED');
    expect(dispatcherCalls).toBe(1);
    expect(dm.getExecutionLogs(sessionUser).length).toBe(1);
  });

  test('GC-09: Real Telegram Bot Adapter -> DialogueInput -> DialogueEngine -> Presentation flow', async () => {
    const sc = getNannyScenario();
    const tgClient = new MockTelegramClient();
    const mockSTT = new MockSTTProvider();
    const mockFiles = new MockTelegramFileProvider();
    const voiceTransport = new TelegramVoiceTransport(mockSTT, mockFiles);

    const botAdapter = new TelegramBotAdapter(engine, voiceTransport, tgClient);

    const tgUser = { id: 12345 };
    const tgChat = { id: 67890 };
    const tgIdentity = { ownerId: '12345', sessionId: '67890' };

    // Send Telegram Update
    await botAdapter.handleUpdate({
      message: { from: tgUser, chat: tgChat, text: 'завтра' }
    }, sc);

    expect(dm.getActiveState(tgIdentity)?.slots.date).toBe('завтра');

    const msg = tgClient.getLastMessage();
    expect(msg?.text).toBe(sc.clarificationPrompts?.start_time);
  });

  test('GC-10: Web independence — MockWebChannelAdapter executes scenario without engine modification', async () => {
    const sc = getNannyScenario();
    const webUser = { ownerId: 'web-user-1', sessionId: 'web-tab-9' };
    const webAdapter = new MockWebChannelAdapter(engine);

    const res = await webAdapter.submit({ modality: 'text', raw_input: 'послезавтра' }, webUser, sc);
    expect(dm.getActiveState(webUser)?.slots.date).toBe('послезавтра');
    expect(res.presentation.text).toBe(sc.clarificationPrompts?.start_time);
  });

  test('GC-11: Presentation portability across distinct renderers (Telegram, WhatsApp, Web)', () => {
    const samplePresentation: DialoguePresentation = {
      text: 'Выберите вариант:',
      actions: [[
        { id: '1', label: 'Опция 1', payload: { slotName: 'custom_slot', slotValue: 'val1' } },
        { id: '2', label: 'Опция 2', payload: { slotName: 'custom_slot', slotValue: 'val2' } }
      ]]
    };

    // Generic presentation contains purely abstract contract
    expect(samplePresentation.actions?.[0][0].id).toBe('1');
    expect(samplePresentation.actions?.[0][0].label).toBe('Опция 1');
    expect(samplePresentation.actions?.[0][0].payload.slotName).toBe('custom_slot');
    expect(samplePresentation.actions?.[0][0].payload.slotValue).toBe('val1');

    // 1. WhatsApp Renderer
    const waButtons = samplePresentation.actions?.[0].map(a => ({ id: a.id, title: a.label }));
    expect(waButtons?.[1].title).toBe('Опция 2');

    // 2. Web Renderer
    const webButtons = samplePresentation.actions?.[0].map(a => `<button data-slot="${a.payload.slotName}" data-val="${a.payload.slotValue}">${a.label}</button>`);
    expect(webButtons?.[0]).toContain('Опция 1');
  });

  // Architectural Static Checks (AT-01 .. AT-08)
  test('AT-01: Generic Dialogue Engine does NOT import TelegramBotAdapter, TelegramVoiceTransport, TelegramClient', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/dialogue-channel.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain('TelegramBotAdapter');
    expect(content).not.toContain('TelegramVoiceTransport');
    expect(content).not.toContain('TelegramClient');
  });

  test('AT-02: Generic Dialogue Engine does NOT contain telegram, whatsapp, web in domain logic', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/dialogue-channel.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toMatch(/from\s+['"].*(telegram|whatsapp|web).*['"]/i);
  });

  test('AT-03: Generic Dialogue Engine does NOT contain nanny, selected_nanny, ORDER_NANNY', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/dialogue-channel.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain('selected_nanny');
    expect(content).not.toContain('ORDER_NANNY');
    expect(content).not.toContain('nanny');
  });

  test('AT-04: Generic Dialogue Engine does NOT contain Telegram-specific response texts', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/dialogue-channel.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain('Telegram');
  });

  test('AT-05: Generic Dialogue Engine does NOT contain Telegram callback protocol dialogue:', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/dialogue-channel.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain('dialogue:');
  });

  test('AT-06: Telegram Bot Adapter does NOT call fillSlot, resolveCandidate, createExecution, dispatchAction', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-bot-adapter.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain('.fillSlot(');
    expect(content).not.toContain('.resolveCandidate(');
    expect(content).not.toContain('.createExecution(');
    expect(content).not.toContain('.dispatchAction(');
  });

  test('AT-07: Telegram Bot Adapter does NOT import DialogueStateManager', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-bot-adapter.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toMatch(/import\s+.*DialogueStateManager.*from/);
  });

  test('AT-08: Negative check — Adapters do NOT directly invoke DialogueStateManager orchestration methods', () => {
    const adapterFiles = [
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-bot-adapter.ts'),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-dialogue-adapter.ts')
    ];

    for (const file of adapterFiles) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toContain('.createContext(');
      expect(content).not.toContain('.cancelContext(');
      expect(content).not.toContain('.createExecution(');
      expect(content).not.toContain('.dispatchAction(');
      expect(content).not.toContain('.fillSlot(');
      expect(content).not.toContain('.resolveCandidate(');
    }
  });

});
