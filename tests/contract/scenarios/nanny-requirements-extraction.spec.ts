import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel, type ScenarioSet } from '../../../src/platform/voice-channel';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const identity = { ownerId: 'nanny-requirements-test', sessionId: 'nanny-requirements-session' };

test.describe('Nanny requirements slot extraction', () => {
  let dm: DialogueStateManager;
  let voice: VoiceChannel;

  test.beforeEach(() => {
    dm = new DialogueStateManager({ enableAutoExpiryScheduler: false });
    voice = new VoiceChannel(dm);
    const scenarioPath = path.resolve(__dirname, '../../../scenario-nanny-order.json');
    const scenarioSet = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as ScenarioSet;
    voice.registerScenarioSet(scenarioSet);
  });

  test('preserves a request for a nanny without bad habits', async () => {
    await voice.handleIncomingVoice('нужна няня без вредных привычек', identity);

    expect(dm.getActiveState(identity)?.slots.requirements).toBe('без вредных привычек');
  });

  test('preserves a request for pedagogical education in instrumental case', async () => {
    await voice.handleIncomingVoice('нужна няня с педагогическим образованием', identity);

    expect(dm.getActiveState(identity)?.slots.requirements).toBe('педагогическое образование');
  });

  test('recognizes pedagogical education in genitive case', async () => {
    await voice.handleIncomingVoice('нужна няня педагогического образования', identity);

    expect(dm.getActiveState(identity)?.slots.requirements).toBe('педагогическое образование');
  });
});
