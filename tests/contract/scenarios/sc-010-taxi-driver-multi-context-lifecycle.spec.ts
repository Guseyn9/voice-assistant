import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const scenarioPath = path.resolve(__dirname, '../../../scenario-sc-010-taxi-driver-multi-context-lifecycle.json');
const rawContent = fs.readFileSync(scenarioPath, 'utf-8');
const scenarioSet = JSON.parse(rawContent);

test.describe('CONTRACT: SC-010 Multi-Context Lifecycle Suite (ТЗ-VOICE-SC-010)', () => {

  test('CONTRACT-01: ScenarioSet v2 Root Schema & Canonical ID Compliance', async () => {
    expect(scenarioSet.version).toBe(2);
    expect(scenarioSet.id).toBe('scenario-set-sc-010-taxi-driver-multi-context-lifecycle');
    expect(Array.isArray(scenarioSet.scenarios)).toBe(true);
    expect(scenarioSet.scenarios.length).toBeGreaterThanOrEqual(1);
  });

  test('CONTRACT-02: Intent ACCEPT_ORDER specifies required slots orderId and payment', async () => {
    const sc = scenarioSet.scenarios.find((s: any) => s.intent === 'ACCEPT_ORDER');
    expect(sc).toBeDefined();
    expect(sc.requiredSlots).toEqual(['orderId', 'payment']);
  });

  test('CONTRACT-03: Declarative slotExtractors defined for integer and enum types', async () => {
    const sc = scenarioSet.scenarios[0];
    expect(sc.slotExtractors).toBeDefined();
    expect(sc.slotExtractors.orderId.type).toBe('integer');
    expect(sc.slotExtractors.payment.type).toBe('enum');
    expect(sc.slotExtractors.payment.mapping.card).toContain('картой');
    expect(sc.slotExtractors.payment.mapping.cash).toContain('наличными');
  });

  test('CONTRACT-04: Action payload template interpolation with canonical event type', async () => {
    const sc = scenarioSet.scenarios[0];
    const emitStep = sc.steps.find((st: any) => st.kind === 'emit');
    expect(emitStep.event.type).toBe('driver.order.accepted');
    expect(emitStep.event.payload.orderId).toBe('{{slots.orderId}}');
    expect(emitStep.event.payload.payment).toBe('{{slots.payment}}');
  });

  test('CONTRACT-05: Terminal kind="end" is enforced for every scenario in set', async () => {
    for (const sc of scenarioSet.scenarios) {
      const last = sc.steps[sc.steps.length - 1];
      expect(last.kind).toBe('end');
    }
  });

  test('CONTRACT-06: Schema contains zero targetState hints', async () => {
    const jsonString = JSON.stringify(scenarioSet);
    expect(jsonString).not.toContain('targetState');
  });

});
