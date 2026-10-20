import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { DialogueEngine } from '../../../src/platform/dialogue-channel';
import { VoiceChannel, type ScenarioSet } from '../../../src/platform/voice-channel';
import {
  TelegramBotAdapter,
  MockTelegramClient,
  type TelegramUpdate
} from '../../../src/platform/telegram-bot-adapter';
import type { TelegramVoiceTransport } from '../../../src/platform/telegram-voice-transport';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('MIXED-NANNY-TEST-BOT: one dialogue state across Telegram buttons, text and voice', () => {
  const identity = { ownerId: 'telegram-user-1001', sessionId: 'telegram-chat-1001' };
  let dm: DialogueStateManager;
  let vc: VoiceChannel;
  let engine: DialogueEngine;
  let telegram: MockTelegramClient;
  let bot: TelegramBotAdapter;
  let dispatched: Array<Record<string, unknown>>;
  let voiceTranscript = '';

  const updateText = (text: string): TelegramUpdate => ({
    message: { from: { id: identity.ownerId }, chat: { id: identity.sessionId }, text }
  });

  const updateVoice = (): TelegramUpdate => ({
    message: {
      from: { id: identity.ownerId },
      chat: { id: identity.sessionId },
      voice: { file_id: 'test-voice-file', mime_type: 'audio/ogg', duration: 3 }
    }
  });

  const callback = (data: string): TelegramUpdate => ({
    callback_query: {
      id: 'callback-1',
      from: { id: identity.ownerId },
      message: { from: { id: identity.ownerId }, chat: { id: identity.sessionId } },
      data
    }
  });

  test.beforeEach(() => {
    dispatched = [];
    voiceTranscript = '';
    dm = new DialogueStateManager({
      enableAutoExpiryScheduler: false,
      actionDispatcher: async (event, context, execution) => {
        dispatched.push({ event, slots: { ...context.slots }, executionId: execution.executionId });
        return { status: 'SUCCEEDED', executionId: execution.executionId, attempt: execution.attempt };
      }
    });
    vc = new VoiceChannel(dm);
    const scenarioPath = path.resolve(__dirname, '../../../scenario-nanny-order.json');
    const scenarioSet = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as ScenarioSet;
    vc.registerScenarioSet(scenarioSet);
    engine = new DialogueEngine(dm, vc);
    telegram = new MockTelegramClient();

    const voiceTransport = {
      processVoiceMessage: async () => ({
        status: 'TRANSCRIPTION_SUCCESS' as const,
        transcript: voiceTranscript,
        confidence: 0.99,
        normalizedInput: { channel: 'voice' as const, transcript: voiceTranscript }
      })
    } as unknown as TelegramVoiceTransport;

    bot = new TelegramBotAdapter(engine, voiceTransport, telegram);
  });

  test('Telegram /start exposes test entry; menu button starts the registered scenario', async () => {
    await bot.handleUpdate(updateText('/start'));
    expect(telegram.getLastMessage()?.text).toContain('голосовыми сообщениями');
    expect(telegram.getLastMessage()?.options?.reply_markup?.inline_keyboard[0][0].callback_data)
      .toBe('start:order-nanny');

    await bot.handleUpdate(callback('start:order-nanny'));
    expect(telegram.getLastMessage()?.text).toBe('Когда нужна няня?');
    const context = dm.getActiveState(identity);
    expect(context?.scenarioId).toBe('order-nanny');
    expect(context?.missingSlots[0]).toBe('date');
  });

  test('one voice utterance fills several slots; next prompt skips them; button correction updates same state', async () => {
    await bot.handleUpdate(updateText('/order_nanny'));
    voiceTranscript = 'нужна няня завтра с трех до восьми на двух детей';
    await bot.handleUpdate(updateVoice());

    let context = dm.getActiveState(identity);
    expect(context?.slots.date).toBe('завтра');
    expect(context?.slots.start_time).toBe('15:00');
    expect(context?.slots.end_time).toBe('20:00');
    expect(context?.slots.children_count).toBe(2);
    expect(context?.missingSlots).not.toContain('date');
    expect(context?.missingSlots).not.toContain('start_time');
    expect(context?.missingSlots).not.toContain('end_time');
    expect(context?.missingSlots).not.toContain('children_count');
    expect(telegram.getLastMessage()?.text).toContain('возраст');

    await bot.handleUpdate(callback(bot.encodeCallbackData('children_count', 3)));
    context = dm.getActiveState(identity);
    expect(context?.slots.children_count).toBe(3);
    expect(dm.listContexts(identity)).toHaveLength(1);
  });

  test('voice and buttons can alternate without creating parallel contexts; confirmation dispatches once', async () => {
    await bot.handleUpdate(updateText('/order_nanny'));

    voiceTranscript = 'завтра с трех до восьми на двух детей';
    await bot.handleUpdate(updateVoice());

    await bot.handleUpdate(callback(bot.encodeCallbackData('children_ages', '4 и 8 лет')));
    await bot.handleUpdate(callback(bot.encodeCallbackData('location', 'Центр')));
    await bot.handleUpdate(callback(bot.encodeCallbackData('requirements', 'без особых требований')));

    const context = dm.getActiveState(identity);
    expect(context).not.toBeNull();
    expect(dm.setOffersForContext(context!.contextId, [
      { offerId: 'nanny-82', id: 'nanny-82', name: 'Мария', index: 1, driver: 'Мария', vehicleType: 'nanny', etaMinutes: 0, price: 0, distanceKm: 0, status: 'AVAILABLE' },
      { offerId: 'nanny-93', id: 'nanny-93', name: 'Анна', index: 2, driver: 'Анна', vehicleType: 'nanny', etaMinutes: 0, price: 0, distanceKm: 0, status: 'AVAILABLE' }
    ] as any, identity)).toBe(true);

    voiceTranscript = 'вторая';
    await bot.handleUpdate(updateVoice());
    expect(dm.getActiveState(identity)?.slots.selected_nanny).toBe('nanny-93');

    voiceTranscript = 'да, подтверждаю';
    await bot.handleUpdate(updateVoice());

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].slots).toMatchObject({
      date: 'завтра',
      start_time: '15:00',
      end_time: '20:00',
      children_count: 2,
      selected_nanny: 'nanny-93',
      confirmation: 'CONFIRMED'
    });
  });

  test('cancel through voice cancels the same context created by the menu command', async () => {
    await bot.handleUpdate(updateText('/order_nanny'));
    const contextId = dm.getActiveState(identity)?.contextId;
    expect(contextId).toBeTruthy();

    voiceTranscript = 'отмена';
    await bot.handleUpdate(updateVoice());

    expect(dm.getContext(contextId!, identity)?.status).toBe('CANCELLED');
    expect(dispatched).toHaveLength(0);
    expect(telegram.getLastMessage()?.text).toContain('отмен');
  });
});
