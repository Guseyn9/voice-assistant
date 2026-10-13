import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const scenarioPath = path.resolve(__dirname, '../../../scenario-sc-007-taxi-driver-context-isolation.json');
const rawContent = fs.readFileSync(scenarioPath, 'utf-8');
const scenarioSet = JSON.parse(rawContent);

test.describe('CONTRACT: SC-007 Context Isolation Suite (ТЗ-VOICE-SC-007)', () => {

  test('CONTRACT-01: ScenarioSet v2 Root Schema & ID Compliance', async () => {
    expect(scenarioSet.version).toBe(2);
    expect(scenarioSet.id).toBe('scenario-set-sc-007-taxi-driver-context-isolation');
    expect(Array.isArray(scenarioSet.scenarios)).toBe(true);
  });

  test('CONTRACT-02: Intent ACCEPT_ORDER specifies orderId and payment Slots', async () => {
    const sc = scenarioSet.scenarios.find((s: any) => s.intent === 'ACCEPT_ORDER');
    expect(sc).toBeDefined();
    expect(sc.requiredSlots).toEqual(['orderId', 'payment']);
  });

  test('CONTRACT-03: Action uses standard template interpolation for orderId and payment', async () => {
    const sc = scenarioSet.scenarios[0];
    const emitStep = sc.steps.find((st: any) => st.kind === 'emit');
    expect(emitStep.event.type).toBe('driver.order.accepted');
    expect(emitStep.event.payload.orderId).toBe('{{slots.orderId}}');
    expect(emitStep.event.payload.payment).toBe('{{slots.payment}}');
  });

  test('CONTRACT-04: Schema contains zero targetState hints', async () => {
    const jsonString = JSON.stringify(scenarioSet);
    expect(jsonString).not.toContain('targetState');
  });

  test('CONTRACT-05: Terminal kind="end" is enforced for every scenario', async () => {
    for (const sc of scenarioSet.scenarios) {
      const last = sc.steps[sc.steps.length - 1];
      expect(last.kind).toBe('end');
    }
  });

  test('CONTRACT-06: Zero hardcoded orderId (1001/1002) in specification structure', async () => {
    const jsonString = JSON.stringify(scenarioSet);
    expect(jsonString).not.toContain('1001');
    expect(jsonString).not.toContain('1002');
  });

});
