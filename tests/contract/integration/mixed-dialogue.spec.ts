import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel, type ScenarioSet } from '../../../src/platform/voice-channel';
import {
  TelegramDialogueAdapter
} from '../../../src/platform/telegram-dialogue-adapter';

test.describe('CONTRACT: SC-INTEGRATION-001 Mixed Button / Text / Voice Dialogue Suite', () => {

  const sessionUser = { ownerId: 'user-nanny-101', sessionId: 'session-tg-001' };

  let dm: DialogueStateManager;
  let vc: VoiceChannel;
  let adapter: TelegramDialogueAdapter;
  let nannyScenarioSet: ScenarioSet;
  let dispatcherCalls: number;
  let dispatchedPayloads: any[];

  test.beforeEach(() => {
    dispatcherCalls = 0;
    dispatchedPayloads = [];
    dm = new DialogueStateManager({
      actionDispatcher: async (event, ctx, exec) => {
        dispatcherCalls++;
        dispatchedPayloads.push({ event, slots: ctx.slots });
        return { status: 'SUCCEEDED', executionId: exec.executionId, attempt: exec.attempt };
      }
    });
    vc = new VoiceChannel(dm);

    const scenarioRaw = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scenario-nanny-order.json'), 'utf8');
    nannyScenarioSet = JSON.parse(scenarioRaw);
    vc.registerScenarioSet(nannyScenarioSet);

    adapter = new TelegramDialogueAdapter(dm, vc);
  });

  const getScenario = () => nannyScenarioSet.scenarios[0];

  const attachCandidates = (userId: typeof sessionUser, candidates: any[]) => {
    const ctx = dm.getActiveState(userId);
    if (ctx) {
      dm.setOffersForContext(ctx.contextId, candidates as any, userId);
    }
  };

  test('Test A — Buttons only: Полный заказ только кнопками', async () => {
    const sc = getScenario();

    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'date', slotValue: 'сегодня' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'start_time', slotValue: '15:00' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'end_time', slotValue: '20:00' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'children_count', slotValue: 2 } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'children_ages', slotValue: '3 и 5 лет' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'location', slotValue: 'Центр' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'requirements', slotValue: 'педагогическое образование' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'selected_nanny', slotValue: 'nanny-1' } }, sessionUser, sc);

    const res = await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'confirmation', slotValue: 'CONFIRMED' } }, sessionUser, sc);

    expect(res.status).toBe('ORDER_CONFIRMED');
    expect(res.slots.date).toBe('сегодня');
    expect(res.slots.selected_nanny).toBe('nanny-1');
    expect(dispatcherCalls).toBe(1);
  });

  test('Test B — Voice only: Полный заказ через transcript (имитация voice)', async () => {
    const sc = getScenario();

    await adapter.handleMessage({ channel: 'voice', transcript: 'нужна няня на завтра' }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'voice', transcript: 'с трех' }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'voice', transcript: 'до восьми' }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'voice', transcript: 'на двух детей' }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'voice', transcript: '3 и 5' }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'voice', transcript: 'центр' }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'voice', transcript: 'без вредных привычек' }, sessionUser, sc);

    // Attach candidates dynamically and choose
    attachCandidates(sessionUser, [
      { id: 'nanny-1', name: 'Мария', index: 1, status: 'AVAILABLE' },
      { id: 'nanny-2', name: 'Анна', index: 2, status: 'AVAILABLE' }
    ]);

    await adapter.handleMessage({ channel: 'voice', transcript: 'выбираю марию' }, sessionUser, sc);
    const res = await adapter.handleMessage({ channel: 'voice', transcript: 'да, подтверждаю' }, sessionUser, sc);

    expect(res.status).toBe('ORDER_CONFIRMED');
    expect(res.slots.selected_nanny).toBe('nanny-1');
    expect(res.slots.date).toBe('завтра');
    expect(dispatcherCalls).toBe(1);
  });

  test('Test C — Button -> Voice: Начать кнопками, продолжить voice', async () => {
    const sc = getScenario();

    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'date', slotValue: 'завтра' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'start_time', slotValue: '15:00' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'voice', transcript: 'до восьми вечера' }, sessionUser, sc);

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('завтра');
    expect(ctx?.slots.start_time).toBe('15:00');
    expect(ctx?.slots.end_time).toBe('20:00');
    expect(dm.listContexts(sessionUser).length).toBe(1);
  });

  test('Test D — Voice -> Button: Начать voice, закончить кнопками', async () => {
    const sc = getScenario();

    await adapter.handleMessage({ channel: 'voice', transcript: 'завтра с трех' }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'end_time', slotValue: '20:00' } }, sessionUser, sc);

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('завтра');
    expect(ctx?.slots.start_time).toBe('15:00');
    expect(ctx?.slots.end_time).toBe('20:00');
    expect(dm.listContexts(sessionUser).length).toBe(1);
  });

  test('Test E — Multiple slots: Одно сообщение заполняет сразу несколько слотов', async () => {
    const sc = getScenario();

    await adapter.handleMessage({
      channel: 'voice',
      transcript: 'нужна няня завтра с трех до восьми на двух детей'
    }, sessionUser, sc);

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('завтра');
    expect(ctx?.slots.start_time).toBe('15:00');
    expect(ctx?.slots.end_time).toBe('20:00');
    expect(ctx?.slots.children_count).toBe(2);

    const inst = adapter.getLastInstrumentation();
    expect(inst?.next_question).toContain('возраст');
  });

  test('Test F — Correction: button -> voice correction («нет, давайте в четыре»)', async () => {
    const sc = getScenario();

    // Button sets 15:00
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'start_time', slotValue: '15:00' } }, sessionUser, sc);
    expect(dm.getActiveState(sessionUser)?.slots.start_time).toBe('15:00');

    // Voice corrects to 16:00
    await adapter.handleMessage({ channel: 'voice', transcript: 'нет, давайте в четыре' }, sessionUser, sc);
    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.status).toBe('WAITING_FOR_SLOT');
    expect(ctx?.slots.start_time).toBe('16:00');
    expect(dm.listContexts(sessionUser).length).toBe(1);
  });

  test('Test G — Reverse correction: voice -> button correction', async () => {
    const sc = getScenario();

    await adapter.handleMessage({ channel: 'voice', transcript: 'в три часа' }, sessionUser, sc);
    expect(dm.getActiveState(sessionUser)?.slots.start_time).toBe('15:00');

    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'start_time', slotValue: '16:00' } }, sessionUser, sc);
    expect(dm.getActiveState(sessionUser)?.slots.start_time).toBe('16:00');
  });

  test('Test H — Candidate selection: FIX-01, FIX-02, FIX-03 real generic candidate resolution', async () => {
    const sc = getScenario();

    // 1. Spying on resolveCandidate to prove candidate selection goes through generic resolver
    let resolverCalls = 0;
    const origResolve = vc.resolveCandidate.bind(vc);
    vc.resolveCandidate = (...args) => {
      resolverCalls++;
      return origResolve(...args);
    };

    // 2. FIX-03: Arbitrary candidate set with completely unknown IDs (not in scenario JSON!)
    const arbitraryCandidates = [
      { id: 'xyz-17', name: 'Ирина', index: 1, status: 'AVAILABLE' },
      { id: 'xyz-42', name: 'Ольга', index: 2, status: 'AVAILABLE' }
    ];

    // Case 1: Voice by Index («вторая») -> resolves to xyz-42
    const userA = { ownerId: 'user-cand-a', sessionId: 'sess-a' };
    await adapter.handleMessage({ channel: 'text', raw_input: 'завтра' }, userA, sc);
    attachCandidates(userA, arbitraryCandidates);

    await adapter.handleMessage({ channel: 'voice', transcript: 'выбираю вторую' }, userA, sc);
    expect(dm.getActiveState(userA)?.slots.selected_nanny).toBe('xyz-42');
    expect(resolverCalls).toBeGreaterThan(0);

    // Case 2: Voice by Name («Ольга») -> resolves to xyz-42
    const userB = { ownerId: 'user-cand-b', sessionId: 'sess-b' };
    await adapter.handleMessage({ channel: 'text', raw_input: 'завтра' }, userB, sc);
    attachCandidates(userB, arbitraryCandidates);

    await adapter.handleMessage({ channel: 'voice', transcript: 'ольга' }, userB, sc);
    expect(dm.getActiveState(userB)?.slots.selected_nanny).toBe('xyz-42');

    // Case 3: Text by Index («вариант 1») -> resolves to xyz-17
    const userC = { ownerId: 'user-cand-c', sessionId: 'sess-c' };
    await adapter.handleMessage({ channel: 'text', raw_input: 'завтра' }, userC, sc);
    attachCandidates(userC, arbitraryCandidates);

    await adapter.handleMessage({ channel: 'text', raw_input: 'вариант 1' }, userC, sc);
    expect(dm.getActiveState(userC)?.slots.selected_nanny).toBe('xyz-17');

    // Case 4: Button by exact ID
    const userD = { ownerId: 'user-cand-d', sessionId: 'sess-d' };
    await adapter.handleMessage({ channel: 'text', raw_input: 'завтра' }, userD, sc);
    attachCandidates(userD, arbitraryCandidates);

    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'selected_nanny', slotValue: 'xyz-42' } }, userD, sc);
    expect(dm.getActiveState(userD)?.slots.selected_nanny).toBe('xyz-42');
  });

  test('Test I — Confirmation: Проверить подтверждение всеми тремя каналами', async () => {
    const sc = getScenario();

    const fillSlots = async (user: { ownerId: string; sessionId: string }) => {
      await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'date', slotValue: 'завтра' } }, user, sc);
      await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'start_time', slotValue: '15:00' } }, user, sc);
      await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'end_time', slotValue: '20:00' } }, user, sc);
      await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'children_count', slotValue: 2 } }, user, sc);
      await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'children_ages', slotValue: '5 лет' } }, user, sc);
      await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'location', slotValue: 'Центр' } }, user, sc);
      await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'requirements', slotValue: 'без особых требований' } }, user, sc);
      await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'selected_nanny', slotValue: 'nanny-1' } }, user, sc);
    };

    // 1. Button confirmation
    const userBtn = { ownerId: 'u-conf-btn', sessionId: 's-conf-btn' };
    await fillSlots(userBtn);
    const resBtn = await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'confirmation', slotValue: 'CONFIRMED' } }, userBtn, sc);
    expect(resBtn.status).toBe('ORDER_CONFIRMED');

    // 2. Text confirmation
    const userTxt = { ownerId: 'u-conf-txt', sessionId: 's-conf-txt' };
    await fillSlots(userTxt);
    const resTxt = await adapter.handleMessage({ channel: 'text', raw_input: 'да, подтверждаю' }, userTxt, sc);
    expect(resTxt.status).toBe('ORDER_CONFIRMED');

    // 3. Voice confirmation
    const userVoice = { ownerId: 'u-conf-voice', sessionId: 's-conf-voice' };
    await fillSlots(userVoice);
    const resVoice = await adapter.handleMessage({ channel: 'voice', transcript: 'подтверждаю' }, userVoice, sc);
    expect(resVoice.status).toBe('ORDER_CONFIRMED');

    expect(dispatcherCalls).toBe(3);
  });

  test('Test J — Cancellation: Проверить отмену всеми тремя каналами', async () => {
    const sc = getScenario();

    // 1. Button cancel
    const userBtn = { ownerId: 'u-can-btn', sessionId: 's-can-btn' };
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'date', slotValue: 'завтра' } }, userBtn, sc);
    const resBtn = await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'confirmation', slotValue: 'REJECTED' } }, userBtn, sc);
    expect(resBtn.status).toBe('CANCELLED');
    expect(dm.getActiveState(userBtn)).toBeNull();

    // 2. Text cancel
    const userTxt = { ownerId: 'u-can-txt', sessionId: 's-can-txt' };
    await adapter.handleMessage({ channel: 'text', raw_input: 'нужна няня' }, userTxt, sc);
    const resTxt = await adapter.handleMessage({ channel: 'text', raw_input: 'отмена' }, userTxt, sc);
    expect(resTxt.status).toBe('CANCELLED');
    expect(dm.getActiveState(userTxt)).toBeNull();

    // 3. Voice cancel
    const userVoice = { ownerId: 'u-can-voice', sessionId: 's-can-voice' };
    await adapter.handleMessage({ channel: 'voice', transcript: 'нужна няня' }, userVoice, sc);
    const resVoice = await adapter.handleMessage({ channel: 'voice', transcript: 'отменяю' }, userVoice, sc);
    expect(resVoice.status).toBe('CANCELLED');
    expect(dm.getActiveState(userVoice)).toBeNull();
  });

  test('Test K — Arbitrary channel switching: button -> voice -> button -> text -> voice -> button', async () => {
    const sc = getScenario();

    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'date', slotValue: 'завтра' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'voice', transcript: 'с трех' }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'end_time', slotValue: '20:00' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'text', raw_input: 'на двух детей' }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'voice', transcript: 'центр' }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'requirements', slotValue: 'без особых требований' } }, sessionUser, sc);

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('завтра');
    expect(ctx?.slots.start_time).toBe('15:00');
    expect(ctx?.slots.end_time).toBe('20:00');
    expect(ctx?.slots.children_count).toBe(2);
    expect(ctx?.slots.location).toBe('Центр');
    expect(ctx?.slots.requirements).toBe('без особых требований');
    expect(dm.listContexts(sessionUser).length).toBe(1);
  });

  test('Test L — State persistence & Instrumentation', async () => {
    const sc = getScenario();

    await adapter.handleMessage({
      channel: 'voice',
      transcript: 'нужна няня завтра'
    }, sessionUser, sc);

    const inst = adapter.getLastInstrumentation();
    expect(inst).not.toBeNull();
    expect(inst?.channel).toBe('voice');
    expect(inst?.transcript).toBe('нужна няня завтра');
    expect(inst?.extracted_slots.date).toBe('завтра');
    expect(inst?.new_state.date).toBe('завтра');
    expect(inst?.confidence).toBe(1.0);
  });

});
