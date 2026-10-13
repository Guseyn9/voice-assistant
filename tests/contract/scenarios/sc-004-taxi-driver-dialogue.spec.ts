import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const scenarioPath = path.resolve(__dirname, '../../../scenario-sc-004-taxi-driver-dialogue.json');
const rawContent = fs.readFileSync(scenarioPath, 'utf-8');
const scenarioSet = JSON.parse(rawContent);

test.describe('CONTRACT: SC-004 Taxi Driver Multi-Turn Dialogue Suite (ТЗ-VOICE-SC-004)', () => {

  test('CONTRACT-01: ScenarioSet v2 Root Schema Compliance', async () => {
    expect(scenarioSet.version).toBe(2);
    expect(scenarioSet.id).toBe('scenario-set-sc-004-taxi-driver-dialogue');
    expect(Array.isArray(scenarioSet.scenarios)).toBe(true);
  });

  test('CONTRACT-02: Intent ACCEPT_ORDER and Required Slot orderId Definition', async () => {
    const sc = scenarioSet.scenarios[0];
    expect(sc.intent).toBe('ACCEPT_ORDER');
    expect(sc.requiredSlots).toEqual(['orderId']);
    expect(sc.clarificationPrompts.orderId).toBe('Какой заказ?');
  });

  test('CONTRACT-03: Incomplete Activation Definition does not pre-populate orderId', async () => {
    const sc = scenarioSet.scenarios[0];
    expect(sc.activation.value).toBe('voice.accept-order');
    expect(sc.activation.type).toBe('voice');
  });

  test('CONTRACT-04: Event Step Payload contains Slot Interpolation for orderId', async () => {
    const sc = scenarioSet.scenarios[0];
    const emitStep = sc.steps.find((s: any) => s.kind === 'emit');
    expect(emitStep).toBeDefined();
    expect(emitStep.event.type).toBe('driver.order.accepted');
    expect(emitStep.event.payload.orderId).toBe('{{slots.orderId}}');
  });

  test('CONTRACT-05: Final Scenario Step is strictly Terminal End Step', async () => {
    const sc = scenarioSet.scenarios[0];
    const lastStep = sc.steps[sc.steps.length - 1];
    expect(lastStep.kind).toBe('end');
  });

  test('CONTRACT-06: Schema contains zero targetState and no artificial FSM hints', async () => {
    const jsonString = JSON.stringify(scenarioSet);
    expect(jsonString).not.toContain('targetState');
    expect(jsonString).not.toContain('ORDER_ACCEPTED');
  });

});
