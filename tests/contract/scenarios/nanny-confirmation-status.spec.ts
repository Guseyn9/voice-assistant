import { test, expect } from '@playwright/test';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel } from '../../../src/platform/voice-channel';

test('nanny confirmation dispatch includes configured business status', async () => {
  const identity = { ownerId: 'nanny-owner', sessionId: 'nanny-session' };
  let dispatchedEvent: any;
  const manager = new DialogueStateManager({
    actionDispatcher: async (event, _context, execution) => {
      dispatchedEvent = event;
      return {
        status: 'SUCCEEDED',
        executionId: execution.executionId,
        attempt: execution.attempt
      };
    }
  });
  const channel = new VoiceChannel(manager);

  channel.registerScenarioSet({
    version: 2,
    id: 'nanny-confirmation-status-test',
    scenarios: [{
      id: 'nanny-confirmation',
      activation: { type: 'voice', value: 'voice.nanny-order' },
      triggerPhrases: ['заказать няню'],
      intent: 'ORDER_NANNY',
      requiredSlots: ['confirmation'],
      confirmation: {
        slot: 'confirmation',
        confirmedValue: 'CONFIRMED',
        confirmedStatus: 'ORDER_CONFIRMED',
        rejectedValue: 'REJECTED'
      },
      slotExtractors: {
        confirmation: {
          type: 'enum',
          rules: [{ pattern: '\\b(да|подтверждаю)\\b', value: 'CONFIRMED' }]
        }
      },
      steps: [{ kind: 'emit', event: { type: 'nanny.order.confirmed', payload: {} } }]
    }]
  });

  await channel.handleIncomingVoice('заказать няню', identity);
  const result = await channel.handleIncomingVoice('да', identity);

  expect(result.status).toBe('COMPLETED');
  expect(dispatchedEvent.type).toBe('nanny.order.confirmed');
  expect(dispatchedEvent.payload.status).toBe('ORDER_CONFIRMED');
});
