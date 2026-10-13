import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { DialogueStateManager, type OfferDefinition } from '../../../src/platform/dialogue-manager';
import { VoiceChannel } from '../../../src/platform/voice-channel';

test.describe('CONTRACT: SC-PASS-002 Multi-Offer Dialogue & Selection Suite', () => {

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

    // Create initial active context with OfferSet
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

  test('CONTRACT-01: Регистрация Offer ScenarioSet валидирует структуру и триггеры', () => {
    expect(vc.getActiveScenarioSetId()).toBe('scenario-set-passenger-offers-002');
  });

  test('CONTRACT-02: OfferSet Context содержит три независимых оффера', () => {
    const ctx = dm.getActiveState(sessionPassengerA);
    expect(ctx?.offers?.length).toBe(3);
    expect(ctx?.offers?.map(o => o.offerId)).toEqual(['OFFER-A', 'OFFER-B', 'OFFER-C']);
  });

  test('CONTRACT-03: Сравнение по ETA («Какой быстрее?») возвращает OFFER-A (4 мин) и 0 execution', async () => {
    const res = await vc.handleIncomingVoice('какой быстрее', sessionPassengerA);

    expect(res.status).toBe('OFFER_COMPARISON_RESOLVED');
    expect(res.bestOfferId).toBe('OFFER-A');
    expect(res.etaMinutes).toBe(4);
    expect(res.response).toMatch(/1|первый/);
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-04: Сравнение по цене («А какой дешевле?») возвращает OFFER-C (90) и 0 execution', async () => {
    const res = await vc.handleIncomingVoice('а какой дешевле', sessionPassengerA);

    expect(res.status).toBe('OFFER_COMPARISON_RESOLVED');
    expect(res.bestOfferId).toBe('OFFER-C');
    expect(res.price).toBe(90);
    expect(res.response).toMatch(/3|третий/);
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-05: Запрос характеристик («А второй это комфорт?») возвращает тип авто и 0 execution', async () => {
    const res = await vc.handleIncomingVoice('а второй это комфорт', sessionPassengerA);

    expect(res.status).toBe('OFFER_QUERY_RESOLVED');
    expect(res.offerId).toBe('OFFER-B');
    expect(res.attributes.vehicleType).toBe('comfort');
    expect((res as any).vehicleType).toBeUndefined();
    expect((res as any).isComfort).toBeUndefined();
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-06: Естественная ссылка «второй» динамически разрешает произвольный ID', async () => {
    const arbitraryOffers: OfferDefinition[] = [
      { offerId: '78431', index: 1, driver: 'Driver 1', vehicleType: 'standard', etaMinutes: 5, price: 100, distanceKm: 1.0, status: 'AVAILABLE' },
      { offerId: '91277', index: 2, driver: 'Driver 2', vehicleType: 'comfort', etaMinutes: 7, price: 160, distanceKm: 0.5, status: 'AVAILABLE' }
    ];
    dm.setOffersForContext(dm.getActiveContextId()!, arbitraryOffers, sessionPassengerA);

    await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);
    const ctx = dm.getActiveState(sessionPassengerA);

    expect(ctx?.slots.selectedOfferId).toBe('91277');
    expect(ctx?.missingSlots).toEqual(['confirmation']);
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
  });

  test('CONTRACT-07: Ambiguous Offer selection («машину подешевле») возвращает AMBIGUOUS_SLOT с кандидатами', async () => {
    const res = await vc.handleIncomingVoice('давайте машину подешевле', sessionPassengerA);

    expect(res.status).toBe('AMBIGUOUS_SLOT');
    expect(res.candidates.length).toBeGreaterThan(1);
  });

  test('CONTRACT-08: Zero execution при ambiguity', async () => {
    await vc.handleIncomingVoice('давайте машину подешевле', sessionPassengerA);
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-09: Recovery после ambiguity (явный выбор «третий» после уточнения)', async () => {
    await vc.handleIncomingVoice('давайте машину подешевле', sessionPassengerA);
    await vc.handleIncomingVoice('тогда давайте третий', sessionPassengerA);

    const ctx = dm.getActiveState(sessionPassengerA);
    expect(ctx?.slots.selectedOfferId).toBe('OFFER-C');
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
  });

  test('CONTRACT-10: Замена выбранного Offer («нет, лучше второй») до подтверждения', async () => {
    await vc.handleIncomingVoice('тогда давайте третий', sessionPassengerA);
    expect(dm.getActiveState(sessionPassengerA)?.slots.selectedOfferId).toBe('OFFER-C');

    await vc.handleIncomingVoice('второй', sessionPassengerA);
    expect(dm.getActiveState(sessionPassengerA)?.slots.selectedOfferId).toBe('OFFER-B');
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
  });

  test('CONTRACT-11: Offer unavailable предотвращает runtime выбор и execution', async () => {
    const unavailableOffers: OfferDefinition[] = [
      { ...testOffers[0] },
      { ...testOffers[1], status: 'UNAVAILABLE' },
      { ...testOffers[2] }
    ];
    dm.setOffersForContext(dm.getActiveContextId()!, unavailableOffers, sessionPassengerA);

    const res = await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);

    expect(res.status).toBe('OFFER_UNAVAILABLE');
    expect(res.offerId).toBe('OFFER-B');

    const ctx = dm.getActiveState(sessionPassengerA);
    expect(ctx?.slots.selectedOfferId).toBeUndefined();
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-12: Несуществующий Offer («выбираю четвертую») возвращает NO_MATCH', async () => {
    const res = await vc.handleIncomingVoice('выбираю четвертую', sessionPassengerA);
    expect(res.status).toBe('NO_MATCH');
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-13: Confirmation («Да») порождает ровно одно execution с выбранным OFFER-B', async () => {
    await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);
    await vc.handleIncomingVoice('да', sessionPassengerA);

    const logs = dm.getExecutionLogs(sessionPassengerA);
    expect(logs.length).toBe(1);
    expect(logs[0].status).toBe('SUCCEEDED');
    expect(logs[0].payload.orderId).toBe(5001);
    expect(logs[0].payload.selectedOfferId).toBe('OFFER-B');
    expect(dispatcherCalls).toBe(1);
  });

  test('CONTRACT-14: Duplicate confirmation («Да» еще раз) идемпотентно не создает второй side-effect', async () => {
    await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);
    await vc.handleIncomingVoice('да', sessionPassengerA);
    await vc.handleIncomingVoice('да', sessionPassengerA);

    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(1);
    expect(dispatcherCalls).toBe(1);
  });

  test('CONTRACT-15: Two-Context Ambiguity Guard — «Какой быстрее?» при двух заказах возвращает AMBIGUOUS_CONTEXT', async () => {
    const ctx2Offers: OfferDefinition[] = [
      { offerId: 'OFFER-X', index: 1, driver: 'Driver X', vehicleType: 'standard', etaMinutes: 2, price: 200, distanceKm: 0.8, status: 'AVAILABLE' }
    ];
    dm.createContext('SELECT_OFFER', { orderId: 5002 }, ['selectedOfferId', 'confirmation'], 'passenger.offer.selected', {}, sessionPassengerA, 'sc-select-passenger-offer', ctx2Offers);

    const res = await vc.handleIncomingVoice('какой быстрее', sessionPassengerA);

    expect(res.status).toBe('AMBIGUOUS_CONTEXT');
    expect(res.candidateContextIds.length).toBe(2);
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

  test('CONTRACT-16: Ownership isolation (Пассажир B не может изменить выбор Пассажира A)', async () => {
    await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);
    const ctxIdA = dm.getActiveContextId()!;

    const foreignAccess = await dm.fillSlot('selectedOfferId', 'OFFER-A', ctxIdA, sessionPassengerB);
    expect(foreignAccess.success).toBe(false);
    expect(foreignAccess.error).toBe('ACCESS_DENIED');
  });

  test('CONTRACT-17: Payload содержит строго один выбранный OfferId', async () => {
    await vc.handleIncomingVoice('тогда давайте третий', sessionPassengerA);
    await vc.handleIncomingVoice('второй', sessionPassengerA);
    await vc.handleIncomingVoice('да', sessionPassengerA);

    const exec = dm.getExecutionLogs(sessionPassengerA)[0];
    expect(exec.payload.selectedOfferId).toBe('OFFER-B');
    expect(exec.payload.selectedOfferId).not.toBe('OFFER-C');
  });

  test('CONTRACT-18: Информационный вопрос («А далеко находится второй водитель?») не меняет selection state', async () => {
    await vc.handleIncomingVoice('тогда давайте второй', sessionPassengerA);
    expect(dm.getActiveState(sessionPassengerA)?.slots.selectedOfferId).toBe('OFFER-B');

    const res = await vc.handleIncomingVoice('а далеко находится второй водитель', sessionPassengerA);
    expect(res.attributes.distanceKm).toBe(0.4);
    expect((res as any).distanceKm).toBeUndefined();

    const ctx = dm.getActiveState(sessionPassengerA);
    expect(ctx?.slots.selectedOfferId).toBe('OFFER-B');
    expect(dm.getExecutionLogs(sessionPassengerA).length).toBe(0);
    expect(dispatcherCalls).toBe(0);
  });

});
