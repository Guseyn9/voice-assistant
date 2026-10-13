import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-passenger-order.json');

test.describe('E2E: SC-PASS-001 Canonical Multi-turn Passenger Dialogue Suite', () => {

  test('E2E-PASS-001: Полный диалог формирования заказа такси пассажиром с проверкой Slot Ambiguity и подтверждения', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__AUTH_OWNER_ID__ = 'passenger-prod-001';
      (window as any).__AUTH_SESSION_ID__ = 'session-prod-passenger-001';
    });

    await page.goto('http://localhost:3000');
    await page.waitForSelector('#voice-app-ready', { timeout: 10000 });

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(scenarioFilePath);

    const result = await page.evaluate(async () => {
      const vc = (window as any).__VOICE_CHANNEL__;
      const dm = (window as any).__DIALOGUE_MANAGER__;
      const app = (window as any).__VOICE_DEMO_APP__;
      const identity = app.getIdentity();

      // Шаг 1: Инициация через общую фразу
      await vc.handleIncomingVoice('Заказать такси', identity);
      const step1Execs = dm.getExecutionLogs(identity).length;

      // Шаг 1.1: Проверка ветки Slot Ambiguity («в терминал» -> AMBIGUOUS_SLOT)
      const ambRes = await vc.handleIncomingVoice('В терминал', identity);
      const ambExecs = dm.getExecutionLogs(identity).length;

      // Шаг 1.2: Разрешение неоднозначности
      await vc.handleIncomingVoice('В аэропорт', identity);

      // Шаг 2: Pickup
      await vc.handleIncomingVoice('Отсюда', identity);
      const step2Execs = dm.getExecutionLogs(identity).length;

      // Шаг 3: Количество пассажиров
      await vc.handleIncomingVoice('Трое', identity);
      const step3Execs = dm.getExecutionLogs(identity).length;

      // Шаг 4: Выбор класса авто
      await vc.handleIncomingVoice('Комфорт', identity);
      const step4Execs = dm.getExecutionLogs(identity).length;

      // Шаг 5: Подтверждение
      const step5Res = await vc.handleIncomingVoice('Да', identity);
      const finalLogs = dm.getExecutionLogs(identity);
      const finalCtx = dm.getContext(finalLogs[0]?.contextId, identity);

      return {
        step1Execs,
        ambRes,
        ambExecs,
        step2Execs,
        step3Execs,
        step4Execs,
        finalLogsCount: finalLogs.length,
        execution: finalLogs[0],
        finalCtx,
        step5Res
      };
    });

    // Zero execution on all steps prior to confirmation
    expect(result.step1Execs).toBe(0);
    expect(result.ambRes.status).toBe('AMBIGUOUS_SLOT');
    expect(result.ambRes.clarificationPrompt).toBe('Уточните, пожалуйста, куда именно вы хотите поехать?');
    expect(result.ambExecs).toBe(0);
    expect(result.step2Execs).toBe(0);
    expect(result.step3Execs).toBe(0);
    expect(result.step4Execs).toBe(0);

    // Exactly one execution created on confirmation
    expect(result.finalLogsCount).toBe(1);
    expect(result.execution).not.toBeNull();
    expect(result.execution.status).toBe('SUCCEEDED');
    expect(result.execution.payload.destination).toBe('airport');
    expect(result.execution.payload.pickup).toBe('CURRENT_LOCATION');
    expect(result.execution.payload.passengerCount).toBe('3');
    expect(result.execution.payload.vehicleType).toBe('comfort');
    expect(result.finalCtx?.status).toBe('COMPLETED');
  });

});
