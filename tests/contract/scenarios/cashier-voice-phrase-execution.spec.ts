import { test, expect } from '@playwright/test';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel, type ScenarioSet } from '../../../src/platform/voice-channel';

const identity = { ownerId: 'cashier-test', sessionId: 'vegetable-stall-session' };

const operations = [
  {
    id: 'cashier-stock-query',
    intent: 'QUERY_INVENTORY_STOCK',
    phrases: [
      'Сколько осталось помидоров?',
      'Покажи остаток помидоров',
      'Какой остаток по томатам?'
    ],
    eventType: 'INVENTORY_STOCK_RESOLVED',
    payload: { itemId: 'tomatoes', quantity: 15, unit: 'kg' }
  },
  {
    id: 'cashier-sale-receipt',
    intent: 'PROCESS_SALE_AND_EMIT_RECEIPT',
    phrases: [
      'Продай клиенту два килограмма помидоров и пробей чек',
      'Оформи два килограмма томатов и выбей чек',
      'Пробей два кило томатов и распечатай чек'
    ],
    eventType: 'SALE_TRANSACTION_COMPLETED',
    payload: {
      itemId: 'tomatoes', quantity: 2, unit: 'kg',
      pricePerUnit: 15, totalAmount: 30, currency: 'AED',
      receiptPrinted: true, receiptId: 'REC-2026-001', remainingStock: 13
    }
  },
  {
    id: 'cashier-price-update',
    intent: 'UPDATE_CATALOG_ITEM_PRICE',
    phrases: [
      'Поставь огурцы по 20 дирхам за килограмм',
      'Огурцы теперь по 20 дирхам',
      'Измени стоимость огурцов на двадцать дирхам'
    ],
    eventType: 'ITEM_PRICE_UPDATED',
    payload: { itemId: 'cucumbers', newPrice: 20, currency: 'AED', unit: 'kg' }
  },
  {
    id: 'cashier-out-of-stock',
    intent: 'SET_ITEM_OUT_OF_STOCK',
    phrases: [
      'Огурцы закончились',
      'Огурцов больше нет',
      'Зафиксируй нулевой остаток огурцов'
    ],
    eventType: 'ITEM_STATUS_OUT_OF_STOCK_TRIGGERED',
    payload: { itemId: 'cucumbers', quantity: 0, status: 'out_of_stock' }
  },
  {
    id: 'cashier-create-item',
    intent: 'CREATE_NEW_CATALOG_ITEM',
    phrases: [
      'Добавь клубнику по 35 дирхам за килограмм',
      'Новый товар: клубника, цена 35 дирхам',
      'Добавь позицию клубника, 35 дирхам за кило'
    ],
    eventType: 'CATALOG_ITEM_CREATED',
    payload: { itemId: 'strawberries', itemName: 'Клубника', category: 'Ягоды', price: 35, currency: 'AED', unit: 'kg' }
  },
  {
    id: 'cashier-stock-update',
    intent: 'SET_INVENTORY_STOCK_LEVEL',
    phrases: [
      'Картофеля осталось 10 килограммов',
      'Установи остаток по картошке 10 кг',
      'Запиши: картофель 10 килограммов'
    ],
    eventType: 'INVENTORY_STOCK_UPDATED',
    payload: { itemId: 'potatoes', quantity: 10, unit: 'kg' }
  }
] as const;

test.describe('SC-001 cashier voice phrase execution', () => {
  for (const operation of operations) {
    for (const phrase of operation.phrases) {
      test(`${operation.id}: executes expected event for “${phrase}”`, async () => {
        const dispatched: Array<{ type: string; payload: Record<string, unknown> }> = [];
        const dm = new DialogueStateManager({
          enableAutoExpiryScheduler: false,
          actionDispatcher: async (event, _context, execution) => {
            dispatched.push({ type: event.type, payload: event.payload });
            return {
              status: 'SUCCEEDED',
              executionId: execution.executionId,
              attempt: execution.attempt
            };
          }
        });
        const channel = new VoiceChannel(dm);
        const scenarioSet: ScenarioSet = {
          version: 2,
          id: `set-${operation.id}`,
          name: 'Vegetable stall cashier phrase execution',
          scenarios: [{
            id: operation.id,
            name: operation.intent,
            activation: { type: 'voice', value: operation.phrases[0] },
            aliases: [...operation.phrases.slice(1)],
            intent: operation.intent,
            steps: [{ kind: 'emit', event: { type: operation.eventType, payload: operation.payload } }]
          }]
        };

        channel.registerScenarioSet(scenarioSet);
        const result = await channel.handleIncomingVoice(phrase, identity);

        expect(result.status).toBe('COMPLETED');
        expect(result.intent).toBe(operation.intent);
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0].type).toBe(operation.eventType);
        expect(dispatched[0].payload).toEqual(operation.payload);

        const logs = dm.getExecutionLogs(identity);
        expect(logs).toHaveLength(1);
        expect(logs[0].event?.type).toBe(operation.eventType);
        expect(logs[0].status).toBe('SUCCEEDED');
      });
    }
  }
});
