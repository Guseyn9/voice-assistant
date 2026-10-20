import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel, type ScenarioSet } from '../../../src/platform/voice-channel';

const identity = { ownerId: 'cashier-test', sessionId: 'vegetable-stall-session' };
const scenarioFile = path.resolve(process.cwd(), 'scenario-sc-001-vegetable-stall.json');
const sourceScenarioSet = JSON.parse(readFileSync(scenarioFile, 'utf8'));

type CashierOperation = {
  id: string;
  intent: string;
  phrases: string[];
  eventType: string;
  payload: Record<string, unknown>;
};

const operations: CashierOperation[] = [];
const sourceSteps = sourceScenarioSet.scenarios[0].steps as Array<{
  kind: string;
  event?: { type: string; payload: Record<string, any> };
}>;

for (let i = 0; i < sourceSteps.length - 1; i += 1) {
  const inputStep = sourceSteps[i];
  const outputStep = sourceSteps[i + 1];
  if (inputStep.event?.type !== 'VOICE_INPUT_RECEIVED' || !outputStep.event) continue;

  const input = inputStep.event.payload;
  operations.push({
    id: input.stepId,
    intent: input.action,
    phrases: [input.text, ...(Array.isArray(input.aliases) ? input.aliases : [])],
    eventType: outputStep.event.type,
    payload: outputStep.event.payload
  });
}

test.describe('SC-001 cashier voice phrase execution from the canonical scenario', () => {
  for (const operation of operations) {
    for (const phrase of operation.phrases) {
      test(`${operation.id}: routes “${phrase}” to ${operation.eventType}`, async () => {
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
          id: `cashier-${operation.id}`,
          name: 'Vegetable stall cashier phrase execution',
          scenarios: [{
            id: operation.id,
            name: operation.intent,
            activation: { type: 'voice', value: operation.phrases[0] },
            aliases: operation.phrases.slice(1),
            intent: operation.intent,
            steps: [{
              kind: 'emit',
              event: { type: operation.eventType, payload: operation.payload }
            }]
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

        if (operation.intent === 'PROCESS_SALE_AND_EMIT_RECEIPT') {
          expect(dispatched[0].payload).toMatchObject({
            quantity: 2,
            totalAmount: 30,
            receiptPrinted: true,
            receiptId: 'REC-2026-001',
            remainingStock: 13
          });
        }
      });
    }
  }
});
