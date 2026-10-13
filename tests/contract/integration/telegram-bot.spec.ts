import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import * as fs from 'fs';
import * as path from 'path';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';
import { VoiceChannel, type ScenarioSet } from '../../../src/platform/voice-channel';
import { TelegramDialogueAdapter } from '../../../src/platform/telegram-dialogue-adapter';
import { MockSTTProvider } from '../../../src/platform/stt-provider';
import { TelegramVoiceTransport } from '../../../src/platform/telegram-voice-transport';
import { MockTelegramFileProvider } from './helpers/telegram-helpers';
import {
  TelegramBotAdapter,
  MockTelegramClient,
  type TelegramUpdate
} from '../../../src/platform/telegram-bot-adapter';

test.describe('CONTRACT: SC-INTEGRATION-003 Production Telegram Bot Voice Adapter Suite', () => {

  const testUser = { id: 777001 };
  const testChat = { id: 999001 };
  const sessionUser = { ownerId: '777001', sessionId: '999001' };

  let dm: DialogueStateManager;
  let vc: VoiceChannel;
  let dialogueAdapter: TelegramDialogueAdapter;
  let mockSTT: MockSTTProvider;
  let mockFileProvider: MockTelegramFileProvider;
  let voiceTransport: TelegramVoiceTransport;
  let telegramClient: MockTelegramClient;
  let botAdapter: TelegramBotAdapter;
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

    const scenarioRaw = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scenario-nanny-order.json'), 'utf8');
    nannyScenarioSet = JSON.parse(scenarioRaw);
    vc.registerScenarioSet(nannyScenarioSet);

    dialogueAdapter = new TelegramDialogueAdapter(dm, vc);
    mockSTT = new MockSTTProvider();
    mockFileProvider = new MockTelegramFileProvider();
    voiceTransport = new TelegramVoiceTransport(mockSTT, mockFileProvider);
    telegramClient = new MockTelegramClient();

    botAdapter = new TelegramBotAdapter(dialogueAdapter, voiceTransport, telegramClient);
  });

  const getScenario = () => nannyScenarioSet.scenarios[0];

  test('TB-01: Text Update -> DialogueContext updated & Telegram response sent', async () => {
    const sc = getScenario();
    const update: TelegramUpdate = {
      message: {
        from: testUser,
        chat: testChat,
        text: 'нужна няня завтра'
      }
    };

    await botAdapter.handleUpdate(update, sc);

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('завтра');

    const lastMsg = telegramClient.getLastMessage();
    expect(lastMsg).toBeDefined();
    expect(lastMsg?.chatId).toBe('999001');
    expect(lastMsg?.text).toBe(sc.clarificationPrompts?.start_time);
  });

  test('TB-02: Button Update (Callback Query) -> DialogueContext updated', async () => {
    const sc = getScenario();

    const cbData = botAdapter.encodeCallbackData('start_time', '15:00');
    const update: TelegramUpdate = {
      callback_query: {
        id: 'cb-123',
        from: testUser,
        message: { chat: testChat },
        data: cbData
      }
    };

    await botAdapter.handleUpdate(update, sc);

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.start_time).toBe('15:00');
    expect(telegramClient.answeredCallbacks).toContain('cb-123');
  });

  test('TB-03: Voice Update -> File downloaded, STT transcribed, slots updated', async () => {
    const sc = getScenario();

    mockFileProvider.registerFile('voice-file-tb3', 'voices/tb3.ogg', 'audio/ogg', Buffer.from('AUDIO_BUFFER'));
    mockSTT.setTranscript('завтра с трех');

    const update: TelegramUpdate = {
      message: {
        from: testUser,
        chat: testChat,
        voice: {
          file_id: 'voice-file-tb3'
        }
      }
    };

    await botAdapter.handleUpdate(update, sc);

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('завтра');
    expect(ctx?.slots.start_time).toBe('15:00');
  });

  test('TB-04: Mixed channels (Text -> Button -> Voice -> Button -> Voice) in ONE shared DialogueContext', async () => {
    const sc = getScenario();

    // 1. Text: date
    await botAdapter.handleUpdate({
      message: { from: testUser, chat: testChat, text: 'завтра' }
    }, sc);

    // 2. Button: start_time
    await botAdapter.handleUpdate({
      callback_query: { id: 'cb-1', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('start_time', '15:00') }
    }, sc);

    // 3. Voice: end_time
    mockFileProvider.registerFile('v-tb4-end', 'v1.ogg', 'audio/ogg', Buffer.from('A'));
    mockSTT.setTranscript('до восьми');
    await botAdapter.handleUpdate({
      message: { from: testUser, chat: testChat, voice: { file_id: 'v-tb4-end' } }
    }, sc);

    // 4. Button: children_count
    await botAdapter.handleUpdate({
      callback_query: { id: 'cb-2', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('children_count', 2) }
    }, sc);

    // 5. Voice: location
    mockFileProvider.registerFile('v-tb4-loc', 'v2.ogg', 'audio/ogg', Buffer.from('B'));
    mockSTT.setTranscript('центр');
    await botAdapter.handleUpdate({
      message: { from: testUser, chat: testChat, voice: { file_id: 'v-tb4-loc' } }
    }, sc);

    // Assert: Single unified context
    expect(dm.listContexts(sessionUser).length).toBe(1);
    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('завтра');
    expect(ctx?.slots.start_time).toBe('15:00');
    expect(ctx?.slots.end_time).toBe('20:00');
    expect(ctx?.slots.children_count).toBe(2);
    expect(ctx?.slots.location).toBe('Центр');
  });

  test('TB-05: Reverse channel switching (Voice -> Button -> Voice)', async () => {
    const sc = getScenario();

    // 1. Voice: "завтра"
    mockFileProvider.registerFile('v-tb5-1', 'v.ogg', 'audio/ogg', Buffer.from('1'));
    mockSTT.setTranscript('завтра');
    await botAdapter.handleUpdate({
      message: { from: testUser, chat: testChat, voice: { file_id: 'v-tb5-1' } }
    }, sc);

    // 2. Button: 15:00
    await botAdapter.handleUpdate({
      callback_query: { id: 'cb-tb5', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('start_time', '15:00') }
    }, sc);

    // 3. Voice: "до восьми"
    mockFileProvider.registerFile('v-tb5-2', 'v.ogg', 'audio/ogg', Buffer.from('2'));
    mockSTT.setTranscript('до восьми');
    await botAdapter.handleUpdate({
      message: { from: testUser, chat: testChat, voice: { file_id: 'v-tb5-2' } }
    }, sc);

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('завтра');
    expect(ctx?.slots.start_time).toBe('15:00');
    expect(ctx?.slots.end_time).toBe('20:00');
  });

  test('TB-06: Confirmation by Button displays [Да] [Отмена] and confirms on [Да]', async () => {
    const sc = getScenario();

    await botAdapter.handleUpdate({ message: { from: testUser, chat: testChat, text: 'завтра с трех до восьми на двух детей' } }, sc);
    await botAdapter.handleUpdate({ callback_query: { id: 'c1', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('children_ages', '5 лет') } }, sc);
    await botAdapter.handleUpdate({ callback_query: { id: 'c2', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('location', 'Центр') } }, sc);
    await botAdapter.handleUpdate({ callback_query: { id: 'c3', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('requirements', 'без требований') } }, sc);
    await botAdapter.handleUpdate({ callback_query: { id: 'c4', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('selected_nanny', 'xyz-42') } }, sc);

    // Verify confirmation prompt was sent with inline keyboard
    const promptMsg = telegramClient.getLastMessage();
    expect(promptMsg?.text).toContain('Подтверждаете');
    expect(promptMsg?.options?.reply_markup?.inline_keyboard).toBeDefined();

    const buttons = promptMsg!.options!.reply_markup!.inline_keyboard[0];
    expect(buttons[0].text).toBe('Да');
    expect(buttons[1].text).toBe('Отмена');

    // Click [Да]
    await botAdapter.handleUpdate({
      callback_query: { id: 'c-yes', from: testUser, message: { chat: testChat }, data: buttons[0].callback_data }
    }, sc);

    expect(dispatcherCalls).toBe(1);
    expect(telegramClient.getLastMessage()?.text).toBe('Заказ подтверждён.');
  });

  test('TB-07: Confirmation by Voice after prompt confirmation displays', async () => {
    const sc = getScenario();

    await botAdapter.handleUpdate({ message: { from: testUser, chat: testChat, text: 'завтра с трех до восьми на двух детей' } }, sc);
    await botAdapter.handleUpdate({ callback_query: { id: 'c1', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('children_ages', '5 лет') } }, sc);
    await botAdapter.handleUpdate({ callback_query: { id: 'c2', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('location', 'Центр') } }, sc);
    await botAdapter.handleUpdate({ callback_query: { id: 'c3', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('requirements', 'без требований') } }, sc);
    await botAdapter.handleUpdate({ callback_query: { id: 'c4', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('selected_nanny', 'xyz-42') } }, sc);

    mockFileProvider.registerFile('v-conf', 'v.ogg', 'audio/ogg', Buffer.from('CONF'));
    mockSTT.setTranscript('да, подтверждаю');

    await botAdapter.handleUpdate({
      message: { from: testUser, chat: testChat, voice: { file_id: 'v-conf' } }
    }, sc);

    expect(dispatcherCalls).toBe(1);
    expect(telegramClient.getLastMessage()?.text).toBe('Заказ подтверждён.');
  });

  test('TB-08: Cancellation by Button', async () => {
    const sc = getScenario();
    await botAdapter.handleUpdate({ message: { from: testUser, chat: testChat, text: 'нужна няня' } }, sc);
    expect(dm.getActiveState(sessionUser)).toBeDefined();

    // Click [Отмена]
    await botAdapter.handleUpdate({
      callback_query: { id: 'c-cancel', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('confirmation', 'REJECTED') }
    }, sc);

    expect(dm.getActiveState(sessionUser)).toBeNull();
    expect(dispatcherCalls).toBe(0);
    expect(telegramClient.getLastMessage()?.text).toBe('Диалог отменён.');
  });

  test('TB-09: Candidate buttons are presented and clicking one resolves correct candidate ID', async () => {
    const sc = getScenario();

    await botAdapter.handleUpdate({ message: { from: testUser, chat: testChat, text: 'завтра' } }, sc);
    const ctx = dm.getActiveState(sessionUser)!;
    expect(dm.setOffersForContext(ctx.contextId, [
      { id: 'xyz-17', name: 'Ирина', index: 1, status: 'AVAILABLE' },
      { id: 'xyz-42', name: 'Ольга', index: 2, status: 'AVAILABLE' }
    ] as any, sessionUser)).toBe(true);

    await botAdapter.handleUpdate({ message: { from: testUser, chat: testChat, text: 'с трех' } }, sc);

    const msg = telegramClient.getLastMessage();
    expect(msg?.options?.reply_markup?.inline_keyboard).toBeDefined();

    const candButtons = msg!.options!.reply_markup!.inline_keyboard[0];
    expect(candButtons.length).toBe(2);
    expect(candButtons[0].text).toBe('Ирина');
    expect(candButtons[1].text).toBe('Ольга');

    // Click second candidate (xyz-42)
    await botAdapter.handleUpdate({
      callback_query: { id: 'cb-cand2', from: testUser, message: { chat: testChat }, data: candButtons[1].callback_data }
    }, sc);

    expect(dm.getActiveState(sessionUser)?.slots.selected_nanny).toBe('xyz-42');
  });

  test('TB-10: STT failure returns transport-level error and preserves DialogueContext', async () => {
    const sc = getScenario();
    await botAdapter.handleUpdate({ message: { from: testUser, chat: testChat, text: 'сегодня' } }, sc);

    mockFileProvider.registerFile('v-fail-stt', 'v.ogg', 'audio/ogg', Buffer.from('data'));
    mockSTT.setFailure(new Error('STT_UNAVAILABLE'));

    await botAdapter.handleUpdate({
      message: { from: testUser, chat: testChat, voice: { file_id: 'v-fail-stt' } }
    }, sc);

    const msg = telegramClient.getLastMessage();
    expect(msg?.text).toContain('Ошибка голосового сообщения: STT_UNAVAILABLE');

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('сегодня');
    expect(dispatcherCalls).toBe(0);
  });

  test('TB-11: Telegram download failure returns transport error and preserves DialogueContext', async () => {
    const sc = getScenario();
    await botAdapter.handleUpdate({ message: { from: testUser, chat: testChat, text: 'сегодня' } }, sc);

    mockFileProvider.registerFile('v-dl-fail', 'v.ogg', 'audio/ogg', Buffer.from('data'));
    mockFileProvider.shouldFailDownload = true;

    await botAdapter.handleUpdate({
      message: { from: testUser, chat: testChat, voice: { file_id: 'v-dl-fail' } }
    }, sc);

    const msg = telegramClient.getLastMessage();
    expect(msg?.text).toContain('TELEGRAM_FILE_DOWNLOAD_FAILED');

    const ctx = dm.getActiveState(sessionUser);
    expect(ctx?.slots.date).toBe('сегодня');
    expect(dispatcherCalls).toBe(0);
  });

  test('TB-12: Callback acknowledgement — answerCallbackQuery is called on every callback query', async () => {
    const sc = getScenario();
    await botAdapter.handleUpdate({
      callback_query: { id: 'cb-ack-test', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('date', 'завтра') }
    }, sc);

    expect(telegramClient.answeredCallbacks).toContain('cb-ack-test');
  });

  // NEW GENERIC PRESENTATION TESTS (TB-13 .. TB-18)

  test('TB-13: Generic confirmation actions — creates buttons for any arbitrary slot name', async () => {
    await botAdapter.sendTelegramResponse('chat-1', {
      text: 'Подтвердить?',
      actions: [[
        {
          id: 'a1',
          label: 'Да',
          payload: {
            slotName: 'any_arbitrary_slot',
            slotValue: 'VALUE_A'
          }
        }
      ]]
    });

    const msg = telegramClient.getLastMessage();
    expect(msg?.text).toBe('Подтвердить?');
    expect(msg?.options?.reply_markup?.inline_keyboard[0][0].text).toBe('Да');
    expect(msg?.options?.reply_markup?.inline_keyboard[0][0].callback_data).toContain('any_arbitrary_slot');
  });

  test('TB-14: Generic candidate actions — creates buttons without nanny/order terminology', async () => {
    await botAdapter.sendTelegramResponse('chat-2', {
      text: 'Выберите вариант:',
      actions: [[
        {
          id: 'x-17',
          label: 'Alpha',
          payload: {
            slotName: 'selected_item',
            slotValue: 'x-17'
          }
        },
        {
          id: 'x-42',
          label: 'Beta',
          payload: {
            slotName: 'selected_item',
            slotValue: 'x-42'
          }
        }
      ]]
    });

    const msg = telegramClient.getLastMessage();
    expect(msg?.text).toBe('Выберите вариант:');
    const buttons = msg!.options!.reply_markup!.inline_keyboard[0];
    expect(buttons[0].text).toBe('Alpha');
    expect(buttons[1].text).toBe('Beta');
    expect(buttons[0].callback_data).toContain('selected_item');
  });

  test('TB-15: Arbitrary domain result — sends text directly without requiring specific status', async () => {
    await botAdapter.sendTelegramResponse('chat-3', {
      text: 'Operation completed'
    });

    const msg = telegramClient.getLastMessage();
    expect(msg?.text).toBe('Operation completed');
    expect(msg?.options).toBeUndefined();
  });

  test('TB-16: No domain response mapping — sends exact presentation text for arbitrary statuses', async () => {
    const arbitraryPresentations = [
      { text: 'Custom Status COMPLETED' },
      { text: 'Custom Status CANCELLED' },
      { text: 'Custom Status ORDER_CONFIRMED' },
      { text: 'Custom Status SOMETHING_ELSE' }
    ];

    for (const pres of arbitraryPresentations) {
      await botAdapter.sendTelegramResponse('chat-4', pres);
      expect(telegramClient.getLastMessage()?.text).toBe(pres.text);
    }
  });

  test('TB-17: Callback round-trip — preserves exact slotName and slotValue', () => {
    const encoded = botAdapter.encodeCallbackData('custom_slot', 'custom_value');
    const decoded = botAdapter.decodeCallbackData(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded?.slotName).toBe('custom_slot');
    expect(decoded?.slotValue).toBe('custom_value');
  });

  test('TB-18: Value containing colon — preserves 15:30 and some:id:value without corruption', () => {
    // Case 1: time format
    const enc1 = botAdapter.encodeCallbackData('start_time', '15:30');
    const dec1 = botAdapter.decodeCallbackData(enc1);
    expect(dec1?.slotName).toBe('start_time');
    expect(dec1?.slotValue).toBe('15:30');

    // Case 2: complex compound colon key
    const enc2 = botAdapter.encodeCallbackData('resource_key', 'some:id:value');
    const dec2 = botAdapter.decodeCallbackData(enc2);
    expect(dec2?.slotName).toBe('resource_key');
    expect(dec2?.slotValue).toBe('some:id:value');
  });

  // Architectural Static Checks (AT-01 .. AT-10)
  test('AT-01: telegram-bot-adapter.ts does NOT import DialogueStateManager directly', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-bot-adapter.ts');
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).not.toMatch(/import\s+.*DialogueStateManager.*from/);
  });

  test('AT-02: Telegram Bot Adapter contains no domain business logic (nanny, ORDER_NANNY, nanny-1)', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-bot-adapter.ts');
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).not.toContain('nanny');
    expect(content).not.toContain('ORDER_NANNY');
    expect(content).not.toContain('nanny-1');
  });

  test('AT-03: Telegram Bot Adapter does NOT call resolveCandidate, fillSlot, createExecution, dispatchAction directly', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-bot-adapter.ts');
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).not.toContain('.resolveCandidate(');
    expect(content).not.toContain('.fillSlot(');
    expect(content).not.toContain('.createExecution(');
    expect(content).not.toContain('.dispatchAction(');
  });

  test('AT-04: Voice uses the same DialogueContext as Button/Text', async () => {
    const sc = getScenario();
    await botAdapter.handleUpdate({ message: { from: testUser, chat: testChat, text: 'завтра' } }, sc);

    mockFileProvider.registerFile('v-at04', 'v.ogg', 'audio/ogg', Buffer.from('X'));
    mockSTT.setTranscript('с трех');
    await botAdapter.handleUpdate({ message: { from: testUser, chat: testChat, voice: { file_id: 'v-at04' } } }, sc);

    const contexts = dm.listContexts(sessionUser);
    expect(contexts.length).toBe(1);
    expect(contexts[0].slots.date).toBe('завтра');
    expect(contexts[0].slots.start_time).toBe('15:00');
  });

  test('AT-05: Button/Text/Voice all route through the same TelegramDialogueAdapter', async () => {
    const sc = getScenario();
    let adapterCalls = 0;
    const origHandle = dialogueAdapter.handleMessage.bind(dialogueAdapter);
    dialogueAdapter.handleMessage = async (...args) => {
      adapterCalls++;
      return origHandle(...args);
    };

    await botAdapter.handleUpdate({ message: { from: testUser, chat: testChat, text: 'завтра' } }, sc);
    await botAdapter.handleUpdate({ callback_query: { id: 'c', from: testUser, message: { chat: testChat }, data: botAdapter.encodeCallbackData('start_time', '15:00') } }, sc);
    mockFileProvider.registerFile('v-at05', 'v.ogg', 'audio/ogg', Buffer.from('Y'));
    mockSTT.setTranscript('до восьми');
    await botAdapter.handleUpdate({ message: { from: testUser, chat: testChat, voice: { file_id: 'v-at05' } } }, sc);

    expect(adapterCalls).toBe(3);
  });

  test('AT-06: telegram-bot-adapter.ts does NOT contain selected_nanny, confirmation, ORDER_CONFIRMED, CANCELLED, nanny', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-bot-adapter.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain('selected_nanny');
    expect(content).not.toContain('confirmation');
    expect(content).not.toContain('ORDER_CONFIRMED');
    expect(content).not.toContain('CANCELLED');
    expect(content).not.toContain('nanny');
  });

  test('AT-07: telegram-bot-adapter.ts does NOT contain literal domain response texts', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-bot-adapter.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain('Диалог отменён.');
    expect(content).not.toContain('Заказ подтверждён.');
  });

  test('AT-08: telegram-bot-adapter.ts does NOT check result.status against domain statuses', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-bot-adapter.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain("result.status === 'CANCELLED'");
    expect(content).not.toContain("result.status === 'ORDER_CONFIRMED'");
  });

  test('AT-09: telegram-bot-adapter.ts does NOT inspect specific missingSlots', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-bot-adapter.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain('missingSlots');
  });

  test('AT-10: telegram-bot-adapter.ts does NOT hardcode callback for any specific slot', () => {
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/platform/telegram-bot-adapter.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain('dialogue:selected_nanny:');
    expect(content).not.toContain('dialogue:confirmation:');
  });

});
