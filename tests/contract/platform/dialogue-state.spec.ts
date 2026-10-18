import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import * as fs from 'fs';
import * as path from 'path';

const scenarioPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scenario-platform-dialogue-slot-filling.json');
const rawContent = fs.readFileSync(scenarioPath, 'utf-8');
const scenarioSet = JSON.parse(rawContent);

test.describe('CONTRACT: Dialogue State & Slot-Filling Schema Suite (ТЗ-VOICE-PLATFORM-005)', () => {

  test('CONTRACT-DS-01: ScenarioSet v2 Root Schema & Required Slots Definition', async () => {
    expect(scenarioSet.version).toBe(2);
    expect(scenarioSet.id).toBe('scenario-set-platform-dialogue-slot-filling');
    expect(Array.isArray(scenarioSet.scenarios)).toBe(true);
    
    const sc = scenarioSet.scenarios[0];
    expect(sc.intent).toBe('PROCESS_TEST_ACTION');
    expect(sc.requiredSlots).toEqual(['item', 'quantity']);
    expect(sc.clarificationPrompts.quantity).toBe('Сколько?');
  });

  test('CONTRACT-DS-02: Scenario Payload & Slot Interpolation Schema Contract', async () => {
    const sc = scenarioSet.scenarios[0];
    const emitStep = sc.steps.find((s: any) => s.kind === 'emit');
    expect(emitStep).toBeDefined();
    expect(emitStep.event.type).toBe('platform.test_action.processed');
    expect(emitStep.event.payload.item).toBe('{{slots.item}}');
    expect(emitStep.event.payload.quantity).toBe('{{slots.quantity}}');
    
    const endStep = sc.steps[sc.steps.length - 1];
    expect(endStep.kind).toBe('end');
  });

});
