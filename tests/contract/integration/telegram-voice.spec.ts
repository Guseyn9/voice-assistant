import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel, type ScenarioSet } from '../../../src/platform/voice-channel';
import { TelegramDialogueAdapter } from '../../../src/platform/telegram-dialogue-adapter';
import { MockSTTProvider } from '../../../src/platform/stt-provider';
import { TelegramVoiceTransport } from '../../../src/platform/telegram-voice-transport';
import { MockTelegramFileProvider } from './helpers/telegram-helpers';

// ES Modules: path.dirname(fileURLToPath(import.meta.url)) does not exist, so we compute the folder of this file.
const testDir = path.dirname(fileURLToPath(import.meta.url));

test.describe('CONTRACT: SC-INTEGRATION-002 Real Telegram Voice Input + STT Integration Suite', () => {

  const sessionUser = { ownerId: 'user-voice-201', sessionId: 'sess-tg-voice-001' };

  let dm: DialogueStateManager;
  let vc: VoiceChannel;
  let adapter: TelegramDialogueAdapter;
  let mockSTT: MockSTTProvider;
  let mockFileProvider: MockTelegramFileProvider;
  let voiceTransport: TelegramVoiceTransport;
  let nannyScenarioSet: ScenarioSet;
  let dispatcherCalls: number;

  test.beforeEach(() => {
    dispatcherCalls = 0;
    dm = new DialogueStateManager({
      actionDispatcher: async (event, ctx, exec) => {
        dispatcherCalls++;
        return { status: 'SUCCEEDED', executionId: exec.executionId, attempt: exec.attempt };
      }
    });
    vc = new VoiceChannel(dm);

    const scenarioRaw = fs.readFileSync(path.resolve(testDir, '../../../scenario-nanny-order.json'), 'utf8');
    nannyScenarioSet = JSON.parse(scenarioRaw);
    vc.registerScenarioSet(nannyScenarioSet);

    adapter = new TelegramDialogueAdapter(dm, vc);
    mockSTT = new MockSTTProvider();
    mockFileProvider = new MockTelegramFileProvider();
    voiceTransport = new TelegramVoiceTransport(mockSTT, mockFileProvider);
  });

  const getScenario = () => nannyScenarioSet.scenarios[0];

  const fakeAudioBuffer = Buffer.from('RIFF_FAKE_AUDIO_DATA_OGG');

  // Helper pipeline simulating the Telegram Voice Transport -> Adapter flow
  const sendVoiceAudio = async (transcript: string) => {
    mockSTT.setTranscript(transcript);
    const transportRes = await voiceTransport.processVoiceMessage({
      fileBuffer: fakeAudioBuffer,
      mimeType: 'audio/ogg'
    });

    if (transportRes.status === 'TRANSCRIPTION_SUCCESS' && transportRes.normalizedInput) {
      return adapter.handleMessage(transportRes.normalizedInput, sessionUser, getScenario());
    }
    return transportRes;
  };

  test('TV-01: Voice -> STT -> Dialogue', async () => {
    await sendVoiceAudio('нужна няня завтра');
    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('завтра');
  });

  test('TV-02: Voice сохраняет существующий context (Button -> Voice -> Voice -> Button)', async () => {
    const sc = getScenario();

    // 1. Button: date = завтра
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'date', slotValue: 'завтра' } }, sessionUser, sc);

    // 2. Voice: "с трех"
    await sendVoiceAudio('с трех');

    // 3. Voice: "до восьми"
    await sendVoiceAudio('до восьми');

    // 4. Button: children_count = 2
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'children_count', slotValue: 2 } }, sessionUser, sc);

    // Assert: Single unified context
    expect(dm.listContexts(sessionUser).length).toBe(1);
    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('завтра');
    expect(ctx?.slots.start_time).toBe('15:00');
    expect(ctx?.slots.end_time).toBe('20:00');
    expect(ctx?.slots.children_count).toBe(2);
  });

  test('TV-03: Voice correction (Button 15:00 -> Voice "нет, давайте в четыре")', async () => {
    const sc = getScenario();

    // Button: 15:00
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'start_time', slotValue: '15:00' } }, sessionUser, sc);
    expect(dm.getActiveState(sessionUser)?.slots.start_time).toBe('15:00');

    // Voice correction
    await sendVoiceAudio('нет, давайте в четыре');

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.status).toBe('WAITING_FOR_SLOT');
    expect(ctx?.slots.start_time).toBe('16:00');
    expect(dm.listContexts(sessionUser).length).toBe(1);
  });

  test('TV-04: Voice candidate selection using existing VoiceChannel.resolveCandidate()', async () => {
    const sc = getScenario();

    let resolverCalls = 0;
    const origResolve = vc.resolveCandidate.bind(vc);
    vc.resolveCandidate = (...args) => {
      resolverCalls++;
      return origResolve(...args);
    };

    await adapter.handleMessage({ channel: 'text', raw_input: 'завтра' }, sessionUser, sc);
    const ctx = dm.getActiveState(sessionUser)!;
    expect(dm.setOffersForContext(ctx.contextId, [
      { id: 'xyz-17', name: 'Ирина', index: 1, status: 'AVAILABLE' },
      { id: 'xyz-42', name: 'Ольга', index: 2, status: 'AVAILABLE' }
    ] as any, sessionUser)).toBe(true);

    await sendVoiceAudio('выбираю вторую');

    expect(dm.getActiveState(sessionUser)?.slots.selected_nanny).toBe('xyz-42');
    expect(resolverCalls).toBeGreaterThan(0);
  });

  test('TV-05: Voice confirmation triggers single execution dispatch', async () => {
    const sc = getScenario();

    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'date', slotValue: 'завтра' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'start_time', slotValue: '15:00' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'end_time', slotValue: '20:00' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'children_count', slotValue: 2 } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'children_ages', slotValue: '5 лет' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'location', slotValue: 'Центр' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'requirements', slotValue: 'без особых требований' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'selected_nanny', slotValue: 'xyz-42' } }, sessionUser, sc);

    const res = await sendVoiceAudio('да, подтверждаю');

    expect(res.status).toBe('ORDER_CONFIRMED');
    expect(dispatcherCalls).toBe(1);
    expect(dm.getExecutionLogs(sessionUser).length).toBe(1);
  });

  test('TV-06: Voice cancellation', async () => {
    const sc = getScenario();
    await adapter.handleMessage({ channel: 'text', raw_input: 'нужна няня' }, sessionUser, sc);
    expect(dm.getActiveState(sessionUser)).toBeDefined();

    const res = await sendVoiceAudio('отменяю');

    expect(res.status).toBe('CANCELLED');
    expect(dm.getActiveState(sessionUser)).toBeNull();
  });

  test('TV-07: STT failure keeps context intact and allows continuation', async () => {
    const sc = getScenario();
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'date', slotValue: 'сегодня' } }, sessionUser, sc);

    mockSTT.setFailure(new Error('STT_UNAVAILABLE'));

    const transportRes = await voiceTransport.processVoiceMessage({
      fileBuffer: fakeAudioBuffer
    });

    expect(transportRes.status).toBe('TRANSPORT_ERROR');
    expect(transportRes.error).toBe('STT_UNAVAILABLE');

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx).toBeDefined();
    expect(ctx?.slots.date).toBe('сегодня');
    expect(dispatcherCalls).toBe(0);

    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'start_time', slotValue: '15:00' } }, sessionUser, sc);
    expect(dm.getActiveState(sessionUser)?.slots.start_time).toBe('15:00');
  });

  test('TV-08: Empty transcript leaves state untouched', async () => {
    const sc = getScenario();
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'date', slotValue: 'сегодня' } }, sessionUser, sc);

    mockSTT.setTranscript('   ');

    const transportRes = await voiceTransport.processVoiceMessage({
      fileBuffer: fakeAudioBuffer
    });

    expect(transportRes.status).toBe('IGNORED_EMPTY_TRANSCRIPT');

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('сегодня');
    expect(dispatcherCalls).toBe(0);
  });

  // NEW TELEGRAM-SPECIFIC CONTRACT TESTS (TV-09 .. TV-12)

  test('TV-09: Telegram file resolution — resolves fileId and passes downloaded audio to STT', async () => {
    const expectedBuffer = Buffer.from('TELEGRAM_VOICE_OGG_BUFFER_123');
    mockFileProvider.registerFile('telegram-file-123', 'voice/file_123.ogg', 'audio/ogg', expectedBuffer);

    let receivedAudioBuffer: Buffer | null = null;
    mockSTT.transcribe = async (audio, opts) => {
      receivedAudioBuffer = audio;
      return { text: 'нужна няня завтра', confidence: 1 };
    };

    const res = await voiceTransport.processVoiceMessage({
      fileId: 'telegram-file-123'
    });

    expect(res.status).toBe('TRANSCRIPTION_SUCCESS');
    expect(res.transcript).toBe('нужна няня завтра');
    expect(receivedAudioBuffer).toEqual(expectedBuffer);
  });

  test('TV-10: Telegram download failure stops pipeline before STT and preserves state', async () => {
    const sc = getScenario();
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'date', slotValue: 'сегодня' } }, sessionUser, sc);

    mockFileProvider.registerFile('file-fail', 'voice/fail.ogg', 'audio/ogg', Buffer.from('audio'));
    mockFileProvider.shouldFailDownload = true;

    let sttCalled = false;
    mockSTT.transcribe = async () => {
      sttCalled = true;
      return { text: 'error text' };
    };

    const transportRes = await voiceTransport.processVoiceMessage({
      fileId: 'file-fail'
    });

    expect(transportRes.status).toBe('TRANSPORT_ERROR');
    expect(transportRes.error).toBe('TELEGRAM_FILE_DOWNLOAD_FAILED');
    expect(sttCalled).toBe(false);

    // Context preserved intact
    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('сегодня');
    expect(dispatcherCalls).toBe(0);
  });

  test('TV-11: MIME/format propagation propagates accurate format to STT', async () => {
    mockFileProvider.registerFile('file-mp3', 'voice/sample.mp3', 'audio/mp3', Buffer.from('mp3-data'));
    mockFileProvider.registerFile('file-ogg', 'voice/sample.ogg', 'audio/ogg; codecs=opus', Buffer.from('ogg-data'));

    let passedFormat: string | undefined;
    mockSTT.transcribe = async (audio, opts) => {
      passedFormat = opts?.format;
      return { text: 'тестовый голос' };
    };

    // Test MP3
    const resMp3 = await voiceTransport.processVoiceMessage({ fileId: 'file-mp3' });
    expect(resMp3.format).toBe('mp3');
    expect(passedFormat).toBe('mp3');

    // Test OGG/Opus
    const resOgg = await voiceTransport.processVoiceMessage({ fileId: 'file-ogg' });
    expect(resOgg.format).toBe('ogg');
    expect(passedFormat).toBe('ogg');
  });

  test('TV-12: Full Telegram Voice path (file_id -> FileProvider -> Audio -> STT -> Adapter -> State -> Dispatcher)', async () => {
    const sc = getScenario();

    // 1. Initial State via Button
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'date', slotValue: 'завтра' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'start_time', slotValue: '15:00' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'end_time', slotValue: '20:00' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'children_count', slotValue: 2 } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'children_ages', slotValue: '5 лет' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'location', slotValue: 'Центр' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'requirements', slotValue: 'без требований' } }, sessionUser, sc);
    await adapter.handleMessage({ channel: 'button', button_payload: { slotName: 'selected_nanny', slotValue: 'xyz-42' } }, sessionUser, sc);

    // 2. Register real-like Telegram voice message in File Provider
    mockFileProvider.registerFile('tg-voice-confirm-file', 'voice/voice_conf.ogg', 'audio/ogg', Buffer.from('REAL_AUDIO_PAYLOAD'));

    // STT recognizes it as "да, подтверждаю"
    mockSTT.setTranscript('да, подтверждаю');

    // 3. Process Telegram voice message with fileId
    const transportRes = await voiceTransport.processVoiceMessage({
      fileId: 'tg-voice-confirm-file'
    });

    expect(transportRes.status).toBe('TRANSCRIPTION_SUCCESS');
    expect(transportRes.normalizedInput).toBeDefined();

    // 4. Feed normalized input into existing Dialogue Adapter
    const finalResult = await adapter.handleMessage(transportRes.normalizedInput!, sessionUser, sc);

    // 5. Verify full business outcome: Execution created and Action dispatched!
    expect(finalResult.status).toBe('ORDER_CONFIRMED');
    expect(dispatcherCalls).toBe(1);
    expect(dm.getExecutionLogs(sessionUser).length).toBe(1);
  });

  // Architectural Static Checks
  test('AT-01: TelegramVoiceTransport does NOT import DialogueStateManager, VoiceChannel, ScenarioDefinition, DomainNannyService', () => {
    const transportPath = path.resolve(testDir, '../../../src/platform/telegram-voice-transport.ts');
    const content = fs.readFileSync(transportPath, 'utf8');

    expect(content).not.toContain('DialogueStateManager');
    expect(content).not.toContain('VoiceChannel');
    expect(content).not.toContain('ScenarioDefinition');
    expect(content).not.toContain('DomainNannyService');
  });

  test('AT-02: STT provider contains no domain business logic (nanny, order, confirmation, candidate)', () => {
    const sttPath = path.resolve(testDir, '../../../src/platform/stt-provider.ts');
    const content = fs.readFileSync(sttPath, 'utf8');

    expect(content.toLowerCase()).not.toContain('nanny');
    expect(content.toLowerCase()).not.toContain('order');
    expect(content.toLowerCase()).not.toContain('confirmation');
    expect(content.toLowerCase()).not.toContain('candidate');
  });

  test('AT-03: TelegramDialogueAdapter does NOT contain direct STT calls', () => {
    const adapterPath = path.resolve(testDir, '../../../src/platform/telegram-dialogue-adapter.ts');
    const content = fs.readFileSync(adapterPath, 'utf8');

    expect(content).not.toContain('sttProvider');
    expect(content).not.toContain('SpeechToTextProvider');
    expect(content).not.toContain('transcribe(');
  });

  test('AT-04: Voice execution uses the exact same DialogueStateManager and ActionDispatcher as Button/Text', async () => {
    const sc = getScenario();

    let dispatchedEvents: string[] = [];
    const sharedDM = new DialogueStateManager({
      actionDispatcher: async (event, ctx, exec) => {
        dispatchedEvents.push(event.type);
        return { status: 'SUCCEEDED', executionId: exec.executionId, attempt: exec.attempt };
      }
    });
    const sharedVC = new VoiceChannel(sharedDM);
    sharedVC.registerScenarioSet(nannyScenarioSet);
    const sharedAdapter = new TelegramDialogueAdapter(sharedDM, sharedVC);

    const u = { ownerId: 'u-at4', sessionId: 's-at4' };
    await sharedAdapter.handleMessage({ channel: 'text', raw_input: 'завтра с трех до восьми на двух детей' }, u, sc);
    await sharedAdapter.handleMessage({ channel: 'button', button_payload: { slotName: 'children_ages', slotValue: '5 лет' } }, u, sc);
    await sharedAdapter.handleMessage({ channel: 'button', button_payload: { slotName: 'location', slotValue: 'Центр' } }, u, sc);
    await sharedAdapter.handleMessage({ channel: 'button', button_payload: { slotName: 'requirements', slotValue: 'без требований' } }, u, sc);
    await sharedAdapter.handleMessage({ channel: 'button', button_payload: { slotName: 'selected_nanny', slotValue: 'nanny-1' } }, u, sc);

    await sharedAdapter.handleMessage({ channel: 'voice', transcript: 'подтверждаю' }, u, sc);

    expect(dispatchedEvents.length).toBe(1);
    expect(dispatchedEvents[0]).toBe('nanny.order.confirmed');
  });

});
