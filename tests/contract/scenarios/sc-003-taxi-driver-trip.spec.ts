import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-sc-003-taxi-driver-trip.json');
const rawContent = fs.readFileSync(scenarioFilePath, 'utf-8');
const scenarioSet = JSON.parse(rawContent);

test.describe('SC-003: Taxi Driver End-to-End Trip - Contract Tests', () => {

  test('CONTRACT-SC003-01: Root Schema, Version 2 and Set ID', async () => {
    expect(scenarioSet).toBeDefined();
    expect(scenarioSet.version).toBe(2);
    expect(scenarioSet.id).toBe('scenario-set-sc-003-taxi-driver-trip');
    expect(scenarioSet.name).toBe('Taxi Driver End-to-End Trip Workflow');
    expect(Array.isArray(scenarioSet.scenarios)).toBe(true);
    expect(scenarioSet.scenarios.length).toBe(1);
  });

  test('CONTRACT-SC003-02: End-to-End Sequential Steps & Uniform orderId 1001', async () => {
    const sc = scenarioSet.scenarios[0];
    expect(sc.id).toBe('sc-003-taxi-driver-trip-workflow');
    
    // Check emit events sequence
    const emitEvents = sc.steps.filter((s: any) => s.kind === 'emit').map((s: any) => s.event.type);
    expect(emitEvents).toEqual([
      'driver.order.accepted',
      'driver.arrived',
      'driver.trip.started',
      'driver.trip.finished',
      'driver.available'
    ]);

    // Check uniform orderId = 1001 for order steps
    expect(sc.steps[0].event.payload.orderId).toBe(1001);
    expect(sc.steps[2].event.payload.orderId).toBe(1001);
    expect(sc.steps[4].event.payload.orderId).toBe(1001);
    expect(sc.steps[6].event.payload.orderId).toBe(1001);

    // Check terminal step
    expect(sc.steps[sc.steps.length - 1].kind).toBe('end');
  });

});
