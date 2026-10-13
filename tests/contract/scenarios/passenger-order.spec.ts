import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel } from '../../../src/platform/voice-channel';

test.describe('CONTRACT: SC-PASS-001 Passenger Order Multi-turn Dialogue Suite', () => {

  const sessionPassengerA = { ownerId: 'passenger-001', sessionId: 'session-pass-A' };
  const sessionPassengerB = { ownerId: 'passenger-002', sessionId: 'session-pass-B' };

  let dm: DialogueStateManager;
  let vc: VoiceChannel;
  let scenarioSet: any;
  let dispatcherCalls: number;

  test.beforeAll(() => {
    const jsonPath = path.resolve(__dirname, '../../../scenario-passenger-order.json');
    scenarioSet = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  });

  test.beforeEach(() => {
    dispatcherCalls = 0;
    dm = new DialogueStateManager({
      actionDispatcher: async (event, ctx, exec) => {
        dispatcherCalls++;
        return { status: 'SUCCEEDED', executionId: exec.executionId, attempt: exec.attempt };
      }
    });
    vc = new VoiceChannel(dm);
    vc.registerScenarioSet(scenarioSet);
  });

  test('CONTRACT-01: Создание Passenger Context по свободной фразе', async () => {
    await vc.handleIncomingVoice('мне нужно в аэропорт', sessionPassengerA);
    const ctx = dm.getActiveState(sessionPassengerA);

    expect(ctx).not.toBeNull();
    expect(ctx?.intent).toBe('CREATE_TAXI_ORDER');
    expect(ctx?.ownerId).toBe('passenger-001');
    expect(ctx?.status).toBe('WAITING_FOR_SLOT');
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
  });

  test('CONTRACT-02: Извлечение destination из первой реплики', async () => {
    await vc.handleIncomingVoice('мне нужно в аэропорт', sessionPassengerA);
    const ctx = dm.getActiveState(sessionPassengerA);

    expect(ctx?.slots.destination).toBe('airport');
    expect(ctx?.missingSlots).toContain('pickup');
    expect(ctx?.clarificationPrompt).toBe('Откуда вас забрать?');
  });

  test('CONTRACT-03: Multi-turn slot filling последовательно заполняет слоты', async () => {
    await vc.handleIncomingVoice('мне нужно в аэропорт', sessionPassengerA);
    await vc.handleIncomingVoice('отсюда', sessionPassengerA);
    let ctx = dm.getActiveState(sessionPassengerA);
    expect(ctx?.slots.pickup).toBe('CURRENT_LOCATION');

    await vc.handleIncomingVoice('трое', sessionPassengerA);
    ctx = dm.getActiveState(sessionPassengerA);
    expect(ctx?.slots.passengerCount).toBe('3');

    await vc.handleIncomingVoice('комфорт', sessionPassengerA);
    ctx = dm.getActiveState(sessionPassengerA);
    expect(ctx?.slots.vehicleType).toBe('comfort');
    expect(ctx?.missingSlots).toEqual(['confirmation']);
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
  });

  test('CONTRACT-04: Недостающий slot не вызывает execution (Zero-Execution Invariant)', async () => {
    await vc.handleIncomingVoice('мне нужно в аэропорт', sessionPassengerA);
    await vc.handleIncomingVoice('отсюда', sessionPassengerA);
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-05: Невалидный slot не изменяет Context и не порождает execution', async () => {
    await vc.handleIncomingVoice('мне нужно в аэропорт', sessionPassengerA);
    const initialCtx = dm.getActiveState(sessionPassengerA);
    const initialVersion = initialCtx?.version;

    await vc.handleIncomingVoice('не знаю', sessionPassengerA);
    const ctxAfterInvalid = dm.getActiveState(sessionPassengerA);

    expect(ctxAfterInvalid?.status).toBe('WAITING_FOR_SLOT');
    expect(ctxAfterInvalid?.slots.destination).toBe('airport');
    expect(ctxAfterInvalid?.slots.pickup).toBeUndefined();
    expect(ctxAfterInvalid?.version).toBe(initialVersion);
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
  });

  test('CONTRACT-06: Slot ambiguity → возвращает AMBIGUOUS_SLOT с декларативным промптом и zero execution (BLOCKER-1 & BLOCKER-2)', async () => {
    // 1. Инициация контекста без destination
    await vc.handleIncomingVoice('заказать такси', sessionPassengerA);
    const ctxBefore = dm.getActiveState(sessionPassengerA);
    expect(ctxBefore?.slots.destination).toBeUndefined();

    // 2. Фраза «в терминал» матчит и terminal_north, и terminal_south с равным priority
    const ambiguityRes = await vc.handleIncomingVoice('в терминал', sessionPassengerA);

    expect(ambiguityRes.status).toBe('AMBIGUOUS_SLOT');
    expect(ambiguityRes.candidates.length).toBe(2);
    expect(ambiguityRes.clarificationPrompt).toBe('Уточните, пожалуйста, куда именно вы хотите поехать?');

    // Context остается неизменным и 0 executions
    const ctxAfter = dm.getActiveState(sessionPassengerA);
    expect(ctxAfter?.slots.destination).toBeUndefined();
    expect(ctxAfter?.status).toBe('WAITING_FOR_SLOT');
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-07: Замена ранее заполненного slot (Recovery)', async () => {
    await vc.handleIncomingVoice('мне нужно в аэропорт', sessionPassengerA);
    expect(dm.getActiveState(sessionPassengerA)?.slots.destination).toBe('airport');

    // Recovery: меняем пункт назначения
    await dm.fillSlot('destination', 'center', dm.getActiveContextId()!, sessionPassengerA);
    const updatedCtx = dm.getActiveState(sessionPassengerA);

    expect(updatedCtx?.slots.destination).toBe('center');
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
  });

  test('CONTRACT-08: Замена vehicleType сохраняет только последнее значение', async () => {
    await vc.handleIncomingVoice('мне нужно в аэропорт', sessionPassengerA);
    await vc.handleIncomingVoice('отсюда', sessionPassengerA);
    await vc.handleIncomingVoice('трое', sessionPassengerA);
    await vc.handleIncomingVoice('комфорт', sessionPassengerA);
    expect(dm.getActiveState(sessionPassengerA)?.slots.vehicleType).toBe('comfort');

    // Передумал: меняем на обычную
    await vc.handleIncomingVoice('обычную', sessionPassengerA);
    const ctx = dm.getActiveState(sessionPassengerA);

    expect(ctx?.slots.vehicleType).toBe('standard');
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
  });

  test('CONTRACT-09: Cancel до confirmation → status CANCELLED, zero execution', async () => {
    await vc.handleIncomingVoice('мне нужно в аэропорт', sessionPassengerA);
    await vc.handleIncomingVoice('отсюда', sessionPassengerA);
    await vc.handleIncomingVoice('отмена', sessionPassengerA);

    const ctx = dm.getContext(dm.getActiveContextId()!, sessionPassengerA);
    expect(ctx?.status).toBe('CANCELLED');
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-10: Confirmation → exactly one execution', async () => {
    await vc.handleIncomingVoice('мне нужно в аэропорт', sessionPassengerA);
    await vc.handleIncomingVoice('отсюда', sessionPassengerA);
    await vc.handleIncomingVoice('трое', sessionPassengerA);
    await vc.handleIncomingVoice('комфорт', sessionPassengerA);
    await vc.handleIncomingVoice('да', sessionPassengerA);

    const logs = dm.getExecutionLogs(sessionPassengerA);
    expect(logs.length).toBe(1);
    expect(logs[0].status).toBe('SUCCEEDED');
    expect(logs[0].payload.destination).toBe('airport');
    expect(logs[0].payload.pickup).toBe('CURRENT_LOCATION');
    expect(logs[0].payload.passengerCount).toBe('3');
    expect(logs[0].payload.vehicleType).toBe('comfort');
    expect(dispatcherCalls).toBe(1);
  });

  test('CONTRACT-11: Duplicate confirmation → idempotently one execution', async () => {
    await vc.handleIncomingVoice('мне нужно в аэропорт', sessionPassengerA);
    await vc.handleIncomingVoice('отсюда', sessionPassengerA);
    await vc.handleIncomingVoice('трое', sessionPassengerA);
    await vc.handleIncomingVoice('комфорт', sessionPassengerA);
    await vc.handleIncomingVoice('да', sessionPassengerA);

    // Повторное «Да»
    await vc.handleIncomingVoice('да', sessionPassengerA);

    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(1);
    expect(dispatcherCalls).toBe(1);
  });

  test('CONTRACT-12: Ownership isolation (Пассажир B не имеет доступа к заказу Пассажира A)', async () => {
    await vc.handleIncomingVoice('мне нужно в аэропорт', sessionPassengerA);
    const contextIdA = dm.getActiveContextId()!;

    expect(dm.getContext(contextIdA, sessionPassengerB)).toBeUndefined();

    const fillRes = await dm.fillSlot('pickup', 'home', contextIdA, sessionPassengerB);
    expect(fillRes.success).toBe(false);
    expect(fillRes.error).toBe('ACCESS_DENIED');
  });

  test('CONTRACT-13: NO_MATCH → zero execution', async () => {
    const res = await vc.handleIncomingVoice('какая сегодня погода', sessionPassengerA);
    expect(res.status).toBe('NO_MATCH');
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-14: Payload содержит только финальные актуальные значения после правок', async () => {
    await vc.handleIncomingVoice('мне нужно в аэропорт', sessionPassengerA);
    await vc.handleIncomingVoice('отсюда', sessionPassengerA);
    await vc.handleIncomingVoice('трое', sessionPassengerA);
    await vc.handleIncomingVoice('комфорт', sessionPassengerA);

    // Правка
    await vc.handleIncomingVoice('обычную', sessionPassengerA);
    await vc.handleIncomingVoice('да', sessionPassengerA);

    const exec = dm.getExecutionLogs(sessionPassengerA)[0];
    expect(exec.payload.vehicleType).toBe('standard');
    expect(exec.payload.destination).toBe('airport');
    expect(exec.payload.passengerCount).toBe('3');
  });

});
