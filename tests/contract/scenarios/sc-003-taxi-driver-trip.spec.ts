import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

const scenarioFilePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scenario-sc-003-taxi-driver-trip.json');
const scenarioSet = JSON.parse(fs.readFileSync(scenarioFilePath, 'utf-8'));

test.describe('SC-003: Taxi Driver End-to-End Trip - Contract Tests', () => {
  test('CONTRACT-SC003-01: Root schema and five declarative trip scenarios', () => {
    expect(scenarioSet).toBeDefined();
    expect(scenarioSet.version).toBe(2);
    expect(scenarioSet.id).toBe('scenario-set-sc-003-taxi-driver-trip');
    expect(scenarioSet.name).toBe('Taxi Driver End-to-End Trip Workflow');
    expect(Array.isArray(scenarioSet.scenarios)).toBe(true);
    expect(scenarioSet.scenarios.map((scenario: any) => scenario.id)).toEqual([
      'sc003-accept-order',
      'sc003-arrived',
      'sc003-start-trip',
      'sc003-finish-trip',
      'sc003-become-available'
    ]);
  });

  test('CONTRACT-SC003-02: Scenario sequence emits the trip lifecycle with consistent order identity', () => {
    const emitEvents = scenarioSet.scenarios.flatMap((scenario: any) =>
      scenario.steps.filter((step: any) => step.kind === 'emit').map((step: any) => step.event.type)
    );
    expect(emitEvents).toEqual([
      'driver.order.accepted',
      'driver.arrived',
      'driver.trip.started',
      'driver.trip.finished',
      'driver.available'
    ]);

    const orderEvents = scenarioSet.scenarios.flatMap((scenario: any) =>
      scenario.steps
        .filter((step: any) => step.kind === 'emit' && step.event.payload.orderId !== undefined)
        .map((step: any) => step.event.payload.orderId)
    );
    expect(orderEvents.length).toBe(4);
    expect(orderEvents.every((orderId: unknown) => orderId === 1001)).toBe(true);
    expect(scenarioSet.scenarios.every((scenario: any) => scenario.steps.at(-1)?.kind === 'end')).toBe(true);
  });
});
