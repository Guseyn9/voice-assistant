import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel } from '../../../src/platform/voice-channel';

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scenario-sc-003-taxi-driver-trip.json');
const scenarioSet = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

test('SC-003 declares explicit intents and resolves standard taxi commands', () => {
  const channel = new VoiceChannel(new DialogueStateManager());
  channel.registerScenarioSet(scenarioSet);

  const cases = [
    ['прими заказ', 'ACCEPT_ORDER'],
    ['я приехал', 'DRIVER_ARRIVED'],
    ['начать поездку', 'START_TRIP'],
    ['завершить поездку', 'FINISH_TRIP'],
    ['готов к следующему заказу', 'DRIVER_AVAILABLE']
  ] as const;

  for (const [phrase, intent] of cases) {
    const result = channel.resolveIntent(phrase);
    expect(result.status, phrase).toBe('RESOLVED');
    if (result.status === 'RESOLVED') {
      expect(result.intent, phrase).toBe(intent);
    }
  }
});
