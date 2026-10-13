import { test, expect } from '@playwright/test';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-passenger-offers.json');

test.describe('E2E: SC-PASS-002 Canonical Multi-Offer Dialogue Suite', () => {

  test('E2E-PASS-002: Полный сквозной диалог сравнения предложений, информационных вопросов и выбора оффера через Production Runtime', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__AUTH_OWNER_ID__ = 'passenger-prod-002';
      (window as any).__AUTH_SESSION_ID__ = 'session-prod-passenger-002';
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

      // Шаг 1: Инициация контекста заказа с доступными офферами
      const initialCtx = dm.createContext(
        'SELECT_OFFER',
        { orderId: 5001 },
        ['selectedOfferId', 'confirmation'],
        'passenger.offer.selected',
        { confirmation: 'Подтвердить выбор?' },
        identity,
        'sc-select-passenger-offer',
        [
          { offerId: 'OFFER-A', index: 1, driver: 'Driver A', vehicleType: 'standard', etaMinutes: 4, price: 120, distanceKm: 1.2, status: 'AVAILABLE' },
          { offerId: 'OFFER-B', index: 2, driver: 'Driver B', vehicleType: 'comfort', etaMinutes: 6, price: 150, distanceKm: 0.4, status: 'AVAILABLE' },
          { offerId: 'OFFER-C', index: 3, driver: 'Driver C', vehicleType: 'standard', etaMinutes: 9, price: 90, distanceKm: 2.1, status: 'AVAILABLE' }
        ]
      );

      // Шаг 2: Вопрос о скорости («Какой быстрее»)
      const step1Res = await vc.handleIncomingVoice('Какой быстрее', identity);
      const step1Execs = dm.getExecutionLogs(identity).length;

      // Шаг 3: Вопрос о цене («А какой дешевле»)
      const step2Res = await vc.handleIncomingVoice('А какой дешевле', identity);
      const step2Execs = dm.getExecutionLogs(identity).length;

      // Шаг 4: Вопрос о характеристиках («А второй это комфорт»)
      const step3Res = await vc.handleIncomingVoice('А второй это комфорт', identity);
      const step3Execs = dm.getExecutionLogs(identity).length;

      // Шаг 5: Выбор конкретного варианта естественным языком («Тогда давайте второй»)
      const step4Res = await vc.handleIncomingVoice('Тогда давайте второй', identity);
      const step4Execs = dm.getExecutionLogs(identity).length;

      // Шаг 6: Дополнительный информационный вопрос до подтверждения («А далеко находится второй водитель»)
      const step5Info = await vc.handleIncomingVoice('А далеко находится второй водитель', identity);
      const step5Execs = dm.getExecutionLogs(identity).length;

      // Шаг 7: Финальное подтверждение («Да»)
      const step6Res = await vc.handleIncomingVoice('Да', identity);
      const finalLogs = dm.getExecutionLogs(identity);
      const finalCtx = dm.getContext(initialCtx.contextId, identity);

      return {
        step1Res,
        step1Execs,
        step2Res,
        step2Execs,
        step3Res,
        step3Execs,
        step4Execs,
        step5Info,
        step5Execs,
        finalLogsCount: finalLogs.length,
        execution: finalLogs[0],
        finalCtx,
        step6Res
      };
    });

    // Zero execution on all intermediate queries and selections
    expect(result.step1Execs).toBe(0);
    expect(result.step2Execs).toBe(0);
    expect(result.step3Execs).toBe(0);
    expect(result.step4Execs).toBe(0);
    expect(result.step5Execs).toBe(0);

    // Deep assertions on actual comparison responses
    expect(result.step1Res.status).toBe('OFFER_COMPARISON_RESOLVED');
    expect(result.step1Res.bestOfferId).toBe('OFFER-A');
    expect(result.step1Res.etaMinutes).toBe(4);

    expect(result.step2Res.status).toBe('OFFER_COMPARISON_RESOLVED');
    expect(result.step2Res.bestOfferId).toBe('OFFER-C');
    expect(result.step2Res.price).toBe(90);

    // Domain-agnostic assertions: checking attributes, no taxi-specific isComfort
    expect(result.step3Res.status).toBe('OFFER_QUERY_RESOLVED');
    expect(result.step3Res.attributes.vehicleType).toBe('comfort');

    expect(result.step5Info.status).toBe('OFFER_QUERY_RESOLVED');
    expect(result.step5Info.attributes.distanceKm).toBe(0.4);

    // Exactly one logical execution produced on confirmation
    expect(result.finalLogsCount).toBe(1);
    expect(result.execution).not.toBeNull();
    expect(result.execution.status).toBe('SUCCEEDED');
    expect(result.execution.payload.orderId).toBe(5001);
    expect(result.execution.payload.selectedOfferId).toBe('OFFER-B');
    expect(result.finalCtx?.status).toBe('COMPLETED');
  });

});
