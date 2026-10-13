import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel, type ScenarioSet } from '../../../src/platform/voice-channel';

test.describe('CONTRACT: SC-PLATFORM-003 Generic Candidate Resolution Portability Suite', () => {

  const sessionUser = { ownerId: 'user-cand-001', sessionId: 'session-cand-A' };

  let dm: DialogueStateManager;
  let vc: VoiceChannel;
  let dispatcherCalls: number;

  // Scenario 1: Offer candidate (Taxi domain, declared binding)
  const scenarioOfferSet: ScenarioSet = {
    version: 1,
    id: 'scenario-set-offers',
    scenarios: [
      {
        id: 'select-offer',
        intent: 'SELECT_OFFER',
        triggerPhrases: ['choose offer'],
        requiredSlots: ['selectedOfferId', 'confirmation'],
        candidateBinding: {
          idField: 'offerId',
          indexField: 'index',
          statusField: 'status',
          unavailableValue: 'UNAVAILABLE'
        },
        slotExtractors: {
          choice: {
            type: 'integer',
            rules: [
              { pattern: '\\b(второй|вариант 2|2)\\b', value: 2 },
              { pattern: '\\b(первый|вариант 1|1)\\b', value: 1 }
            ]
          },
          confirmation: {
            type: 'enum',
            rules: [
              { pattern: '\\bconfirm\\b', value: 'CONFIRMED' },
              { pattern: '\\breject\\b', value: 'REJECTED' }
            ]
          }
        },
        steps: [{ kind: 'emit', event: { type: 'offer.confirmed', payload: {} } }]
      }
    ]
  };

  // Scenario 2: Service candidate (serviceId, custom unavailable template)
  const scenarioServiceSet: ScenarioSet = {
    version: 1,
    id: 'scenario-set-services',
    scenarios: [
      {
        id: 'select-service',
        intent: 'SELECT_SERVICE',
        triggerPhrases: ['choose service'],
        requiredSlots: ['selectedServiceId', 'confirmation'],
        candidateBinding: {
          idField: 'serviceId',
          indexField: 'index',
          statusField: 'state',
          unavailableValue: 'DISABLED',
          unavailableTemplate: 'Услуга {{targetId}} временно отключена'
        },
        slotExtractors: {
          choice: {
            type: 'integer',
            rules: [
              { pattern: '\\b(второй|вариант 2|2)\\b', value: 2 },
              { pattern: '\\b(первый|вариант 1|1)\\b', value: 1 }
            ]
          },
          confirmation: {
            type: 'enum',
            rules: [
              { pattern: '\\bconfirm\\b', value: 'CONFIRMED' },
              { pattern: '\\breject\\b', value: 'REJECTED' }
            ]
          }
        },
        steps: [{ kind: 'emit', event: { type: 'service.confirmed', payload: {} } }]
      }
    ]
  };

  // Scenario 3: Arbitrary Entity (itemId, custom index field "rank")
  const scenarioItemSet: ScenarioSet = {
    version: 1,
    id: 'scenario-set-items',
    scenarios: [
      {
        id: 'select-item',
        intent: 'SELECT_ITEM',
        triggerPhrases: ['choose item'],
        requiredSlots: ['selectedItemId', 'confirmation'],
        candidateBinding: {
          idField: 'itemId',
          indexField: 'rank',
          statusField: 'availability',
          unavailableValue: 'OUT_OF_STOCK'
        },
        slotExtractors: {
          choice: {
            type: 'integer',
            rules: [
              { pattern: '\\b(номер 7|7)\\b', value: 7 },
              { pattern: '\\b(номер 3|3)\\b', value: 3 }
            ]
          },
          confirmation: {
            type: 'enum',
            rules: [
              { pattern: '\\bconfirm\\b', value: 'CONFIRMED' },
              { pattern: '\\breject\\b', value: 'REJECTED' }
            ]
          }
        },
        steps: [{ kind: 'emit', event: { type: 'item.confirmed', payload: {} } }]
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

  test('CANDIDATE-01: Offer candidate -> resolves offerId correctly', async () => {
    vc.registerScenarioSet(scenarioOfferSet);

    const candidates = [
      { offerId: 'offer-1', index: 1, status: 'AVAILABLE' },
      { offerId: 'offer-2', index: 2, status: 'AVAILABLE' }
    ];

    dm.createContext(
      'SELECT_OFFER',
      {},
      ['selectedOfferId', 'confirmation'],
      'offer.confirmed',
      {},
      sessionUser,
      'select-offer',
      candidates as any
    );

    await vc.handleIncomingVoice('второй', sessionUser);
    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.selectedOfferId).toBe('offer-2');
  });

  test('CANDIDATE-02: Service candidate -> resolves serviceId correctly', async () => {
    vc.registerScenarioSet(scenarioServiceSet);

    const services = [
      { serviceId: 'srv-cleaning', index: 1, state: 'ACTIVE' },
      { serviceId: 'srv-plumbing', index: 2, state: 'ACTIVE' }
    ];

    dm.createContext(
      'SELECT_SERVICE',
      {},
      ['selectedServiceId', 'confirmation'],
      'service.confirmed',
      {},
      sessionUser,
      'select-service',
      services as any
    );

    await vc.handleIncomingVoice('вариант 2', sessionUser);
    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.selectedServiceId).toBe('srv-plumbing');
  });

  test('CANDIDATE-03: Arbitrary item candidate -> resolves itemId correctly', async () => {
    vc.registerScenarioSet(scenarioItemSet);

    const items = [
      { itemId: 'item-3', rank: 3, availability: 'IN_STOCK' },
      { itemId: 'item-7', rank: 7, availability: 'IN_STOCK' }
    ];

    dm.createContext(
      'SELECT_ITEM',
      {},
      ['selectedItemId', 'confirmation'],
      'item.confirmed',
      {},
      sessionUser,
      'select-item',
      items as any
    );

    await vc.handleIncomingVoice('7', sessionUser);
    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.selectedItemId).toBe('item-7');
  });

  test('CANDIDATE-04: Different ID field names (offerId vs serviceId vs itemId) work via single resolver', async () => {
    const resOffer = vc.resolveCandidate(
      { choice: 1 },
      [{ offerId: 'off-x', index: 1 }],
      { idField: 'offerId', indexField: 'index' },
      'sc1',
      'slotA'
    );
    expect(resOffer.status).toBe('RESOLVED');
    if (resOffer.status === 'RESOLVED') {
      expect(resOffer.targetId).toBe('off-x');
    }

    const resService = vc.resolveCandidate(
      { choice: 1 },
      [{ serviceId: 'srv-y', index: 1 }],
      { idField: 'serviceId', indexField: 'index' },
      'sc2',
      'slotB'
    );
    expect(resService.status).toBe('RESOLVED');
    if (resService.status === 'RESOLVED') {
      expect(resService.targetId).toBe('srv-y');
    }
  });

  test('CANDIDATE-05: Different index field names (index vs rank) work declaratively', async () => {
    const resRank = vc.resolveCandidate(
      { choice: 7 },
      [{ itemId: 'custom-item', rank: 7 }],
      { idField: 'itemId', indexField: 'rank' },
      'sc3',
      'slotC'
    );
    expect(resRank.status).toBe('RESOLVED');
    if (resRank.status === 'RESOLVED') {
      expect(resRank.targetId).toBe('custom-item');
    }
  });

  test('CANDIDATE-06: Unavailable state is declaratively configured', async () => {
    const resDisabled = vc.resolveCandidate(
      { choice: 2 },
      [{ serviceId: 'srv-2', index: 2, state: 'DISABLED' }],
      { idField: 'serviceId', indexField: 'index', statusField: 'state', unavailableValue: 'DISABLED', unavailableTemplate: 'Услуга {{targetId}} отключена' },
      'sc',
      'slot'
    );
    expect(resDisabled.status).toBe('CANDIDATE_UNAVAILABLE');
    if (resDisabled.status === 'CANDIDATE_UNAVAILABLE') {
      expect(resDisabled.targetId).toBe('srv-2');
      expect(resDisabled.message).toBe('Услуга srv-2 отключена');
    }
  });

  test('CANDIDATE-07: No Offer-specific response text in generic candidate resolution', async () => {
    const resItemUnavail = vc.resolveCandidate(
      { choice: 3 },
      [{ itemId: 'it-3', index: 3, status: 'UNAVAILABLE' }],
      { idField: 'itemId', indexField: 'index' },
      'sc',
      'slot'
    );
    expect(resItemUnavail.status).toBe('CANDIDATE_UNAVAILABLE');
    if (resItemUnavail.status === 'CANDIDATE_UNAVAILABLE') {
      expect(resItemUnavail.message).not.toContain('Предложение');
      expect(resItemUnavail.message).not.toContain('Водитель');
      expect(resItemUnavail.message).not.toContain('Такси');
    }
  });

  test('CANDIDATE-08: No hidden offerId fallback in resolveCandidate', () => {
    const res = vc.resolveCandidate(
      { choice: 1 },
      [{ otherField: 'test', index: 1 }],
      { indexField: 'index' },
      'sc',
      'slot'
    );
    expect(res.status).toBe('RESOLVED');
    if (res.status === 'RESOLVED') {
      expect(res.targetId).toBe('');
    }
  });

  test('CANDIDATE-09: Архитектурный тест — в resolveCandidate отсутствуют доменные термины и семантика Taxi Offer', () => {
    const vcPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/voice-channel.ts');
    const vcContent = fs.readFileSync(vcPath, 'utf8');

    const funcMatch = vcContent.match(/resolveCandidate\([\s\S]*?\n\s{2}\}/);
    expect(funcMatch).not.toBeNull();
    const funcBody = funcMatch![0];

    expect(funcBody).not.toContain('OfferDefinition');
    expect(funcBody).not.toContain("'offerId'");
    expect(funcBody).not.toContain('"offerId"');
    expect(funcBody).not.toContain('OFFER_UNAVAILABLE');
    expect(funcBody).not.toContain('Предложение');
    expect(funcBody).not.toContain("'cheapest'");
    expect(funcBody).not.toContain("'fastest'");
  });

  test('CANDIDATE-10: One runtime handles full selection + confirmation lifecycle across domains (Service, Item, Offer)', async () => {
    // 1. Service full lifecycle and payload verification
    vc.registerScenarioSet(scenarioServiceSet);
    dm.createContext(
      'SELECT_SERVICE',
      {},
      ['selectedServiceId', 'confirmation'],
      'service.confirmed',
      {},
      sessionUser,
      'select-service',
      [{ serviceId: 'srv-clean', index: 1, state: 'ACTIVE' }] as any
    );

    await vc.handleIncomingVoice('1', sessionUser);
    await vc.handleIncomingVoice('confirm', sessionUser);

    const logsService = dm.getExecutionLogs(sessionUser);
    expect(logsService.length).toBe(1);
    expect(logsService[0].payload.selectedServiceId).toBe('srv-clean');
    expect(logsService[0].payload.confirmation).toBe('CONFIRMED');

    // 2. Arbitrary Item full lifecycle and payload verification
    const sessionUserItem = { ownerId: 'user-cand-002', sessionId: 'session-cand-B' };
    vc.registerScenarioSet(scenarioItemSet);
    dm.createContext(
      'SELECT_ITEM',
      {},
      ['selectedItemId', 'confirmation'],
      'item.confirmed',
      {},
      sessionUserItem,
      'select-item',
      [{ itemId: 'item-galaxy', rank: 7, availability: 'IN_STOCK' }] as any
    );

    await vc.handleIncomingVoice('7', sessionUserItem);
    await vc.handleIncomingVoice('confirm', sessionUserItem);

    const logsItem = dm.getExecutionLogs(sessionUserItem);
    expect(logsItem.length).toBe(1);
    expect(logsItem[0].payload.selectedItemId).toBe('item-galaxy');
    expect(logsItem[0].payload.confirmation).toBe('CONFIRMED');

    // 3. Offer full lifecycle and payload verification
    const sessionUserOffer = { ownerId: 'user-cand-003', sessionId: 'session-cand-C' };
    vc.registerScenarioSet(scenarioOfferSet);
    dm.createContext(
      'SELECT_OFFER',
      {},
      ['selectedOfferId', 'confirmation'],
      'offer.confirmed',
      {},
      sessionUserOffer,
      'select-offer',
      [{ offerId: 'offer-vip-777', index: 2, status: 'AVAILABLE' }] as any
    );

    await vc.handleIncomingVoice('2', sessionUserOffer);
    await vc.handleIncomingVoice('confirm', sessionUserOffer);

    const logsOffer = dm.getExecutionLogs(sessionUserOffer);
    expect(logsOffer.length).toBe(1);
    expect(logsOffer[0].payload.selectedOfferId).toBe('offer-vip-777');
    expect(logsOffer[0].payload.confirmation).toBe('CONFIRMED');
  });

});
