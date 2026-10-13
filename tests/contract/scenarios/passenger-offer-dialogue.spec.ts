import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { DialogueStateManager, type OfferDefinition } from '../../../src/platform/dialogue-manager';
import { VoiceChannel } from '../../../src/platform/voice-channel';

test.describe('CONTRACT: SC-PASS-003 Multi-Step Offer Selection & Correction Suite', () => {

  const sessionPassengerA = { ownerId: 'passenger-001', sessionId: 'session-pass-A' };
  const sessionPassengerB = { ownerId: 'passenger-002', sessionId: 'session-pass-B' };

  let dm: DialogueStateManager;
  let vc: VoiceChannel;
  let scenarioSet: any;
  let dispatcherCalls: number;

  const testOffers: OfferDefinition[] = [
    { offerId: 'OFFER-A', index: 1, driver: 'Driver A', vehicleType: 'standard', etaMinutes: 4, price: 120, distanceKm: 1.2, status: 'AVAILABLE' },
    { offerId: 'OFFER-B', index: 2, driver: 'Driver B', vehicleType: 'comfort', etaMinutes: 6, price: 150, distanceKm: 0.4, status: 'AVAILABLE' },
    { offerId: 'OFFER-C', index: 3, driver: 'Driver C', vehicleType: 'standard', etaMinutes: 9, price: 90, distanceKm: 2.1, status: 'AVAILABLE' }
  ];

  test.beforeAll(() => {
    const jsonPath = path.resolve(__dirname, '../../../scenario-passenger-offers.json');
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

    // Initial offer set context
    dm.createContext(
      'SELECT_OFFER',
      { orderId: 5001 },
      ['selectedOfferId', 'confirmation'],
      'passenger.offer.selected',
      { confirmation: 'Подтвердить выбор?' },
      sessionPassengerA,
      'sc-select-passenger-offer',
      testOffers
    );
  });

  test('CONTRACT-01: Initial selection («тогда давайте второй») сохраняет OFFER-B и не запускает execution', async () => {
    await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);

    const ctx = dm.getActiveState(sessionPassengerA);
    expect(ctx?.slots.selectedOfferId).toBe('OFFER-B');
    expect(ctx?.slots.confirmation).toBeUndefined();
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-02: Selection replacement («нет, тогда первый») заменяет OFFER-B на OFFER-A без execution', async () => {
    await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);
    expect(dm.getActiveState(sessionPassengerA)?.slots.selectedOfferId).toBe('OFFER-B');

    await vc.handleIncomingVoice('нет, тогда первый', sessionPassengerA);

    const ctx = dm.getActiveState(sessionPassengerA);
    expect(ctx?.slots.selectedOfferId).toBe('OFFER-A');
    expect(ctx?.slots.confirmation).toBeUndefined();
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-03: Confirmation («Да») исполняет именно последний выбранный OFFER-A', async () => {
    await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);
    await vc.handleIncomingVoice('нет, тогда первый', sessionPassengerA);
    await vc.handleIncomingVoice('да', sessionPassengerA);

    const logs = dm.getExecutionLogs(sessionPassengerA);
    expect(logs.length).toBe(1);
    expect(dispatcherCalls).toBe(1);
    expect(logs[0].status).toBe('SUCCEEDED');
    expect(logs[0].payload.selectedOfferId).toBe('OFFER-A');
    expect(logs[0].payload.selectedOfferId).not.toBe('OFFER-B');
  });

  test('CONTRACT-04: Ни один из промежуточных шагов до подтверждения не порождает execution', async () => {
    await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);

    await vc.handleIncomingVoice('нет, тогда первый', sessionPassengerA);
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);

    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-05: Rejection («Нет») оставляет контекст активным и не создаёт execution', async () => {
    await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);
    expect(dm.getActiveState(sessionPassengerA)?.slots.selectedOfferId).toBe('OFFER-B');

    const rejectRes = await vc.handleIncomingVoice('нет', sessionPassengerA);
    expect(rejectRes.status).toBe('SELECTION_REJECTED');

    const ctx = dm.getActiveState(sessionPassengerA);
    expect(ctx?.status).toBe('WAITING_FOR_SLOT');
    expect(ctx?.slots.selectedOfferId).toBe('OFFER-B');
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-06: Новый выбор после rejection («нет, лучше первый» -> «да») выполняет OFFER-A', async () => {
    await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);
    await vc.handleIncomingVoice('нет', sessionPassengerA);
    await vc.handleIncomingVoice('нет, лучше первый', sessionPassengerA);
    await vc.handleIncomingVoice('да', sessionPassengerA);

    const logs = dm.getExecutionLogs(sessionPassengerA);
    expect(logs.length).toBe(1);
    expect(dispatcherCalls).toBe(1);
    expect(logs[0].payload.selectedOfferId).toBe('OFFER-A');
  });

  test('CONTRACT-07: Duplicate confirmation идемпотентно не создает второй side-effect', async () => {
    await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);
    await vc.handleIncomingVoice('да', sessionPassengerA);
    await vc.handleIncomingVoice('да', sessionPassengerA);

    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(1);
    expect(dispatcherCalls).toBe(1);
  });

  test('CONTRACT-08: Ownership isolation (Пассажир B не может изменить или подтвердить выбор Пассажира A)', async () => {
    await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);
    const ctxIdA = dm.getActiveContextId()!;

    const foreignFill = await dm.fillSlot('selectedOfferId', 'OFFER-A', ctxIdA, sessionPassengerB);
    expect(foreignFill.success).toBe(false);
    expect(foreignFill.error).toBe('ACCESS_DENIED');

    const foreignConfirm = await dm.fillSlot('confirmation', 'CONFIRMED', ctxIdA, sessionPassengerB);
    expect(foreignConfirm.success).toBe(false);
    expect(foreignConfirm.error).toBe('ACCESS_DENIED');
  });

});
