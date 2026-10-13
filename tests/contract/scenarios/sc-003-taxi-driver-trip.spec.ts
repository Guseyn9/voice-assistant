import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    expect(scenarioSet.scenarios.length).toBe(5);
  });

  test('CONTRACT-SC003-02: All trip stages have correct events and terminal steps', async () => {
    const scenarioIds = scenarioSet.scenarios.map((sc: any) => sc.id);
    expect(scenarioIds).toEqual([
      'sc003-accept-order',
      'sc003-arrived',
      'sc003-start-trip',
      'sc003-finish-trip',
      'sc003-become-available'
    ]);

    const emitEvents = scenarioSet.scenarios.flatMap((sc: any) =>
      sc.steps.filter((step: any) => step.kind === 'emit').map((step: any) => step.event.type)
    );
    expect(emitEvents).toEqual([
      'driver.order.accepted',
      'driver.arrived',
      'driver.trip.started',
      'driver.trip.finished',
      'driver.available'
    ]);

    for (const sc of scenarioSet.scenarios) {
      expect(sc.steps[sc.steps.length - 1].kind).toBe('end');
    }
    for (const sc of scenarioSet.scenarios.slice(0, 4)) {
      const orderEvent = sc.steps.find((step: any) => step.kind === 'emit' && step.event.payload.orderId !== undefined);
      expect(orderEvent.event.payload.orderId).toBe(1001);
    }
  });

});
