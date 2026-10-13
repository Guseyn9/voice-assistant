import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const scenarioPath = path.resolve(__dirname, '../../../scenario-sc-005-taxi-driver-full-trip.json');
const rawContent = fs.readFileSync(scenarioPath, 'utf-8');
const scenarioSet = JSON.parse(rawContent);

test.describe('CONTRACT: SC-005 Taxi Driver Full Trip Workflow Suite (ТЗ-VOICE-SC-005)', () => {

  test('CONTRACT-01: ScenarioSet v2 Root Schema Compliance', async () => {
    expect(scenarioSet.version).toBe(2);
    expect(scenarioSet.id).toBe('scenario-set-sc-005-taxi-driver-full-trip');
    expect(Array.isArray(scenarioSet.scenarios)).toBe(true);
  });

  test('CONTRACT-02: Exactly 5 Continuous Workflow Scenarios Defined', async () => {
    expect(scenarioSet.scenarios).toHaveLength(5);
    const intents = scenarioSet.scenarios.map((s: any) => s.intent);
    expect(intents).toEqual(['ACCEPT_ORDER', 'DRIVER_ARRIVED', 'START_TRIP', 'FINISH_TRIP', 'DRIVER_AVAILABLE']);
  });

  test('CONTRACT-03: ACCEPT_ORDER Requires orderId Slot with Clarification Prompt', async () => {
    const sc = scenarioSet.scenarios[0];
    expect(sc.intent).toBe('ACCEPT_ORDER');
    expect(sc.requiredSlots).toEqual(['orderId']);
    expect(sc.clarificationPrompts.orderId).toBe('Какой заказ?');
  });

  test('CONTRACT-04: Single Consistent orderId across Entire Workflow', async () => {
    const emitSteps = scenarioSet.scenarios.map((s: any) => s.steps.find((step: any) => step.kind === 'emit'));
    expect(emitSteps[0].event.payload.orderId).toBe('{{slots.orderId}}');
    expect(emitSteps[1].event.payload.orderId).toBe(1001);
    expect(emitSteps[2].event.payload.orderId).toBe(1001);
    expect(emitSteps[3].event.payload.orderId).toBe(1001);
  });

  test('CONTRACT-05: Zero targetState Hints in Schema', async () => {
    const jsonString = JSON.stringify(scenarioSet);
    expect(jsonString).not.toContain('targetState');
  });

  test('CONTRACT-06: Every Scenario Ends with Kind "end"', async () => {
    for (const sc of scenarioSet.scenarios) {
      const last = sc.steps[sc.steps.length - 1];
      expect(last.kind).toBe('end');
    }
  });

  test('CONTRACT-07: Valid Sequential Event Types Defined', async () => {
    const eventTypes = scenarioSet.scenarios.map((s: any) => s.steps[0].event.type);
    expect(eventTypes).toEqual([
      'driver.order.accepted',
      'driver.arrived',
      'driver.trip.started',
      'driver.trip.finished',
      'driver.available'
    ]);
  });

});
