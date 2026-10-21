import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel, type ScenarioSet } from '../../../src/platform/voice-channel';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const identity = { ownerId: 'nanny-order-slots-test', sessionId: 'nanny-order-slots-session' };

const cases = [
  { phrase: 'нужна няня завтра', slot: 'date', expected: 'завтра' },
  { phrase: 'нужна няня сегодня', slot: 'date', expected: 'сегодня' },
  { phrase: 'нужна няня с четырех', slot: 'start_time', expected: '16:00' },
  { phrase: 'нужна няня в 15:00', slot: 'start_time', expected: '15:00' },
  { phrase: 'нужна няня до восьми', slot: 'end_time', expected: '20:00' },
  { phrase: 'нужна няня до 18:00', slot: 'end_time', expected: '18:00' },
  { phrase: 'нужна няня на двух детей', slot: 'children_count', expected: 2 },
  { phrase: 'нужна няня на троих', slot: 'children_count', expected: 3 },
  { phrase: 'нужна няня для детей 3 и 5 лет', slot: 'children_ages', expected: '3 и 5 лет' },
  { phrase: 'нужна няня в центре', slot: 'location', expected: 'Центр' },
  { phrase: 'нужна няня на улице Ленина 10', slot: 'location', expected: 'ул. Ленина 10' }
] as const;

test.describe('Nanny order slot extraction', () => {
  let dm: DialogueStateManager;
  let voice: VoiceChannel;

  test.beforeEach(() => {
    dm = new DialogueStateManager({ enableAutoExpiryScheduler: false });
    voice = new VoiceChannel(dm);
    const scenarioPath = path.resolve(__dirname, '../../../scenario-nanny-order.json');
    const scenarioSet = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as ScenarioSet;
    voice.registerScenarioSet(scenarioSet);
  });

  for (const { phrase, slot, expected } of cases) {
    test(`extracts ${slot} from "${phrase}"`, async () => {
      await voice.handleIncomingVoice(phrase, identity);

      expect(dm.getActiveState(identity)?.slots[slot]).toBe(expected);
    });
  }
});
