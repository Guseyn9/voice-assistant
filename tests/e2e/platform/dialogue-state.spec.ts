import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-platform-dialogue-slot-filling.json');

test.describe('E2E: Strict Platform Dialogue State & Multi-Turn Slot-Filling Suite (ТЗ-VOICE-PLATFORM-005)', () => {

  async function setupApp(page: any) {
    const appUrl = process.env.APP_URL || 'https://voice-assistant-two-olive.vercel.app';
    await page.goto(appUrl);
    await expect(page.locator('body')).toBeVisible();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(scenarioFilePath);
    await expect(page.locator('body')).toContainText('Platform Dialogue State');
  }

  async function emitVoicePhrase(page: any, phrase: string) {
    await page.evaluate(async (text: string) => {
      const channel = (window as any).__VOICE_CHANNEL__;
      if (!channel) {
        throw new Error('VoiceChannel production instance is not initialized on window.__VOICE_CHANNEL__');
      }
      return channel.handleIncomingVoice(text);
    }, phrase);
  }

  test('DIALOGUE-E2E-01 & 02: Incomplete Voice Command -> WAITING_FOR_SLOT, missing quantity & Clarification Prompt', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Обработай яблоки');

    const state = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm ? dm.getActiveState() : null;
    });

    expect(state).not.toBeNull();
    expect(state.status).toBe('WAITING_FOR_SLOT');
    expect(state.intent).toBe('PROCESS_TEST_ACTION');
    expect(state.slots).toEqual({ item: 'apples' });
    expect(state.missingSlots).toEqual(['quantity']);
    expect(state.clarificationPrompt).toBe('Сколько?');
  });

  test('DIALOGUE-E2E-03: Multi-Turn Slot Filling Completes Action via DialogueStateManager (item=apples, quantity=5)', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Обработай яблоки');
    await emitVoicePhrase(page, 'Пять');

    const state = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm ? dm.getActiveState() : null;
    });

    expect(state.status).toBe('COMPLETED');
    expect(state.slots).toEqual({ item: 'apples', quantity: 5 });

    const executedPayload = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const logs = dm ? dm.getExecutionLogs() : [];
      const targetAction = logs.find((l: any) => l.intent === 'PROCESS_TEST_ACTION');
      return targetAction ? targetAction.payload : null;
    });

    expect(executedPayload).toEqual({
      item: 'apples',
      quantity: 5
    });
  });

  test('DIALOGUE-E2E-04: Invalid Response Preserves Dialogue Context and missingSlots in DialogueStateManager', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Обработай яблоки');
    await emitVoicePhrase(page, 'Не знаю');

    const state = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm ? dm.getActiveState() : null;
    });

    expect(state.status).toBe('WAITING_FOR_SLOT');
    expect(state.missingSlots).toEqual(['quantity']);

    // Subsequent valid answer successfully completes dialogue
    await emitVoicePhrase(page, 'Пять');
    
    const completedState = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm ? dm.getActiveState() : null;
    });
    expect(completedState.status).toBe('COMPLETED');
  });

  test('DIALOGUE-E2E-05: Cancellation terminates Dialogue State to CANCELLED in DialogueStateManager', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Обработай яблоки');
    await emitVoicePhrase(page, 'Отмена');

    const state = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm ? dm.getActiveState() : null;
    });

    expect(state.status).toBe('CANCELLED');

    const hasExecuted = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const logs = dm ? dm.getExecutionLogs() : [];
      return logs.some((l: any) => l.intent === 'PROCESS_TEST_ACTION');
    });
    expect(hasExecuted).toBe(false);
  });

  test('DIALOGUE-E2E-06: New independent command resets active Dialogue State', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Обработай яблоки');
    
    // New command resets previous incomplete dialogue
    await emitVoicePhrase(page, 'Продай помидоры');

    const state = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm ? dm.getActiveState() : null;
    });

    expect(state.intent).toBe('PROCESS_SALE');
    expect(state.slots).toEqual({ item: 'tomatoes' });
    expect(state.status).toBe('WAITING_FOR_SLOT');
  });

  test('DIALOGUE-E2E-07: Inactivity Timeout triggers EXPIRED Dialogue State in DialogueStateManager', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Обработай яблоки');

    await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      if (dm) dm.triggerTimeout();
    });

    const state = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      return dm ? dm.getActiveState() : null;
    });

    expect(state.status).toBe('EXPIRED');
  });

  test('DIALOGUE-E2E-08: Idempotency - duplicate slot input guarantees strict executionCount === 1 in DialogueStateManager', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Обработай яблоки');
    await emitVoicePhrase(page, 'Пять');
    
    // Duplicate utterance
    await emitVoicePhrase(page, 'Пять');

    const executionCount = await page.evaluate(() => {
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const logs = dm ? dm.getExecutionLogs() : [];
      return logs.filter((l: any) => l.intent === 'PROCESS_TEST_ACTION').length;
    });

    expect(executionCount).toBe(1);
  });

});
