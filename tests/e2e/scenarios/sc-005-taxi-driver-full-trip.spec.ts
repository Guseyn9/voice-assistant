import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-sc-005-taxi-driver-full-trip.json');

test.describe('E2E: SC-005 Taxi Driver Full Trip Workflow & Real FSM Suite (ТЗ-VOICE-SC-005)', () => {

  async function setupApp(page: any) {
    const appUrl = process.env.APP_URL || 'https://voice-assistant-two-olive.vercel.app';
    await page.goto(appUrl);
    await expect(page.locator('body')).toBeVisible();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(scenarioFilePath);
    await expect(page.locator('body')).toContainText('Taxi Driver Full Trip');
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

  test('WORKFLOW-01: Full Continuous Trip Workflow (AVAILABLE -> ORDER_ACCEPTED -> ARRIVED -> IN_TRIP -> FINISHED -> AVAILABLE) with strict Event & Payload validation', async ({ page }) => {
    await setupApp(page);
    const fsmLocator = page.locator('[data-testid="fsm-driver-state"], .driver-status, [data-testid="driver-status"]').first();

    // 1. Incomplete "Прими заказ" -> WAITING_FOR_SLOT
    await emitVoicePhrase(page, 'Прими заказ');
    const state = await page.evaluate(() => (window as any).__DIALOGUE_MANAGER__.getActiveState());
    expect(state.status).toBe('WAITING_FOR_SLOT');
    expect(state.clarificationPrompt).toBe('Какой заказ?');

    // 2. "1001" -> ORDER_ACCEPTED & validate event driver.order.accepted { orderId: 1001 }
    await emitVoicePhrase(page, '1001');
    await expect(fsmLocator).toHaveText(/ORDER_ACCEPTED|Принят/i);
    const acceptAction = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.find((l: any) => l.intent === 'ACCEPT_ORDER');
    });
    expect(acceptAction).toBeDefined();
    expect(acceptAction.payload).toEqual({ orderId: 1001 });

    // 3. "Я приехал" -> DRIVER_ARRIVED & validate event driver.arrived { orderId: 1001 }
    await emitVoicePhrase(page, 'Я приехал');
    await expect(fsmLocator).toHaveText(/DRIVER_ARRIVED|На месте/i);
    const arrivedAction = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.find((l: any) => l.intent === 'DRIVER_ARRIVED');
    });
    expect(arrivedAction).toBeDefined();
    expect(arrivedAction.payload).toEqual({ orderId: 1001 });

    // 4. "Начать поездку" -> IN_TRIP & validate event driver.trip.started { orderId: 1001 }
    await emitVoicePhrase(page, 'Начать поездку');
    await expect(fsmLocator).toHaveText(/IN_TRIP|В пути/i);
    const startAction = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.find((l: any) => l.intent === 'START_TRIP');
    });
    expect(startAction).toBeDefined();
    expect(startAction.payload).toEqual({ orderId: 1001 });

    // 5. "Завершить поездку" -> TRIP_FINISHED & validate event driver.trip.finished { orderId: 1001, payment: 'cash' }
    await emitVoicePhrase(page, 'Завершить поездку');
    await expect(fsmLocator).toHaveText(/TRIP_FINISHED|Завершена/i);
    const finishAction = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.find((l: any) => l.intent === 'FINISH_TRIP');
    });
    expect(finishAction).toBeDefined();
    expect(finishAction.payload).toEqual({ orderId: 1001, payment: 'cash' });

    // 6. "Готов к следующему заказу" -> AVAILABLE & validate event driver.available { status: 'available' }
    await emitVoicePhrase(page, 'Готов к следующему заказу');
    await expect(fsmLocator).toHaveText(/AVAILABLE|Свободен/i);
    const availableAction = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.find((l: any) => l.intent === 'DRIVER_AVAILABLE');
    });
    expect(availableAction).toBeDefined();
    expect(availableAction.payload).toEqual({ status: 'available' });
  });

  test('NEG-01: "Я приехал" from AVAILABLE is rejected and FSM stays strictly in AVAILABLE', async ({ page }) => {
    await setupApp(page);
    const fsmLocator = page.locator('[data-testid="fsm-driver-state"], .driver-status, [data-testid="driver-status"]').first();

    await emitVoicePhrase(page, 'Я приехал');
    // BLOCKER-1 FIX: Strict assertion of AVAILABLE state
    await expect(fsmLocator).toHaveText(/AVAILABLE|Свободен/i);

    const executed = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.some((l: any) => l.intent === 'DRIVER_ARRIVED');
    });
    expect(executed).toBe(false);
  });

  test('NEG-02: "Начать поездку" before arrival is rejected by FSM and no trip.started event is emitted', async ({ page }) => {
    await setupApp(page);
    const fsmLocator = page.locator('[data-testid="fsm-driver-state"], .driver-status, [data-testid="driver-status"]').first();

    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, '1001');
    await expect(fsmLocator).toHaveText(/ORDER_ACCEPTED|Принят/i);

    // Illegal voice action
    await emitVoicePhrase(page, 'Начать поездку');
    await expect(fsmLocator).toHaveText(/ORDER_ACCEPTED|Принят/i);

    // HIGH-3 FIX: Assert zero execution of START_TRIP
    const illegalStarts = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.intent === 'START_TRIP');
    });
    expect(illegalStarts).toHaveLength(0);
  });

  test('NEG-03: "Завершить поездку" before start is rejected by FSM and no trip.finished event is emitted', async ({ page }) => {
    await setupApp(page);
    const fsmLocator = page.locator('[data-testid="fsm-driver-state"], .driver-status, [data-testid="driver-status"]').first();

    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, '1001');
    await emitVoicePhrase(page, 'Я приехал');
    await expect(fsmLocator).toHaveText(/DRIVER_ARRIVED|На месте/i);

    // Illegal voice action
    await emitVoicePhrase(page, 'Завершить поездку');
    await expect(fsmLocator).toHaveText(/DRIVER_ARRIVED|На месте/i);

    // HIGH-3 FIX: Assert zero execution of FINISH_TRIP
    const illegalFinishes = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.intent === 'FINISH_TRIP');
    });
    expect(illegalFinishes).toHaveLength(0);
  });

  test('RECOVERY-01: Multi-turn Error Recovery preserves full trip workflow', async ({ page }) => {
    await setupApp(page);
    const fsmLocator = page.locator('[data-testid="fsm-driver-state"], .driver-status, [data-testid="driver-status"]').first();

    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, 'Не знаю');
    await emitVoicePhrase(page, '1001');
    await expect(fsmLocator).toHaveText(/ORDER_ACCEPTED|Принят/i);

    await emitVoicePhrase(page, 'Я приехал');
    await expect(fsmLocator).toHaveText(/DRIVER_ARRIVED|На месте/i);
  });

  test('IDEMP-01: Duplicate "1001" gives strictly executionCount === 1 for ACCEPT_ORDER with orderId=1001', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, '1001');
    await emitVoicePhrase(page, '1001');

    // HIGH-4 FIX: Bind strictly to intent + orderId: 1001
    const executionCount = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.intent === 'ACCEPT_ORDER' && l.payload?.orderId === 1001).length;
    });

    expect(executionCount).toBe(1);
  });

  test('IDEMP-02: Duplicate "Я приехал" gives strictly executionCount === 1 for DRIVER_ARRIVED with orderId=1001', async ({ page }) => {
    await setupApp(page);
    await emitVoicePhrase(page, 'Прими заказ');
    await emitVoicePhrase(page, '1001');
    await emitVoicePhrase(page, 'Я приехал');
    await emitVoicePhrase(page, 'Я приехал');

    // HIGH-4 FIX: Bind strictly to intent + orderId: 1001
    const executionCount = await page.evaluate(() => {
      const logs = (window as any).__DIALOGUE_MANAGER__.getExecutionLogs();
      return logs.filter((l: any) => l.intent === 'DRIVER_ARRIVED' && l.payload?.orderId === 1001).length;
    });

    expect(executionCount).toBe(1);
  });

});
