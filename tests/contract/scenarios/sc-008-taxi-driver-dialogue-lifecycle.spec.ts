import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const scenarioPath = path.resolve(__dirname, '../../../scenario-sc-008-taxi-driver-dialogue-lifecycle.json');
const rawContent = fs.readFileSync(scenarioPath, 'utf-8');
const scenarioSet = JSON.parse(rawContent);

test.describe('CONTRACT: SC-008 Dialogue Lifecycle, Cancellation & Recovery Suite (ТЗ-VOICE-SC-008)', () => {

  test('CONTRACT-01: ScenarioSet v2 Root Schema & ID Compliance', async () => {
    expect(scenarioSet.version).toBe(2);
    expect(scenarioSet.id).toBe('scenario-set-sc-008-taxi-driver-dialogue-lifecycle');
    expect(Array.isArray(scenarioSet.scenarios)).toBe(true);
    expect(scenarioSet.scenarios.length).toBeGreaterThanOrEqual(1);
  });

  test('CONTRACT-02: Intent ACCEPT_ORDER specifies required orderId and payment slots', async () => {
    const sc = scenarioSet.scenarios.find((s: any) => s.intent === 'ACCEPT_ORDER');
    expect(sc).toBeDefined();
    expect(sc.requiredSlots).toEqual(['orderId', 'payment']);
  });

  test('CONTRACT-03: orderId Slot Definition & Prompt Contract', async () => {
    const sc = scenarioSet.scenarios[0];
    expect(sc.clarificationPrompts.orderId).toBe('Какой заказ?');
  });

  test('CONTRACT-04: payment Slot Definition & Prompt Contract', async () => {
    const sc = scenarioSet.scenarios[0];
    expect(sc.clarificationPrompts.payment).toBe('Какой способ оплаты?');
  });

  test('CONTRACT-05: Action Payload template interpolation for orderId and payment', async () => {
    const sc = scenarioSet.scenarios[0];
    const emitStep = sc.steps.find((st: any) => st.kind === 'emit');
    expect(emitStep.event.type).toBe('driver.order.accepted');
    expect(emitStep.event.payload.orderId).toBe('{{slots.orderId}}');
    expect(emitStep.event.payload.payment).toBe('{{slots.payment}}');
  });

  test('CONTRACT-06: Final step is strictly terminal kind="end" with zero targetState hints', async () => {
    const jsonString = JSON.stringify(scenarioSet);
    expect(jsonString).not.toContain('targetState');
    for (const sc of scenarioSet.scenarios) {
      const last = sc.steps[sc.steps.length - 1];
      expect(last.kind).toBe('end');
    }
  });

});
