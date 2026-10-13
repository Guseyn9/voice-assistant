import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../../scenario-sc-002-taxi-driver.json');
const rawContent = fs.readFileSync(scenarioFilePath, 'utf-8');
const scenarioSet = JSON.parse(rawContent);

test.describe('SC-002: Taxi Driver Standard Trip - Contract & Schema Tests', () => {

  test('CONTRACT-01: ScenarioSet v2 Root Schema & 5 Scenarios Existence', async () => {
    expect(scenarioSet).toBeDefined();
    expect(scenarioSet.version).toBe(2);
    expect(scenarioSet.id).toBe('scenario-set-sc-002-taxi-driver');
    expect(scenarioSet.name).toBe('Taxi Driver Standard Trip');
    expect(Array.isArray(scenarioSet.scenarios)).toBe(true);
    expect(scenarioSet.scenarios.length).toBe(5);
  });

  test('CONTRACT-02: Scenario 1 - accept-order (voice.accept-order -> driver.order.accepted)', async () => {
    const sc = scenarioSet.scenarios.find((s: any) => s.id === 'accept-order');
    expect(sc).toBeDefined();
    expect(sc.activation).toEqual({ type: 'voice', value: 'voice.accept-order' });
    expect(sc.expectedPhrase).toBe('Принять заказ');
    expect(sc.aliases).toContain('Принимаю заказ');
    expect(sc.steps[0].kind).toBe('emit');
    expect(sc.steps[0].event.type).toBe('driver.order.accepted');
    expect(sc.steps[0].event.payload).toEqual({ orderId: 1001 });
    expect(sc.steps[sc.steps.length - 1].kind).toBe('end');
  });

  test('CONTRACT-03: Scenario 2 - arrived (voice.arrived -> driver.arrived with delay)', async () => {
    const sc = scenarioSet.scenarios.find((s: any) => s.id === 'arrived');
    expect(sc).toBeDefined();
    expect(sc.activation).toEqual({ type: 'voice', value: 'voice.arrived' });
    expect(sc.expectedPhrase).toBe('Я приехал');
    expect(sc.aliases).toContain('Прибыл');
    expect(sc.steps[0].kind).toBe('delay');
    expect(sc.steps[0].ms).toBe(500);
    expect(sc.steps[1].kind).toBe('emit');
    expect(sc.steps[1].event.type).toBe('driver.arrived');
    expect(sc.steps[1].event.payload).toEqual({ orderId: 1001 });
    expect(sc.steps[sc.steps.length - 1].kind).toBe('end');
  });

  test('CONTRACT-04: Scenario 3 - start-trip (voice.start-trip -> driver.trip.started)', async () => {
    const sc = scenarioSet.scenarios.find((s: any) => s.id === 'start-trip');
    expect(sc).toBeDefined();
    expect(sc.activation).toEqual({ type: 'voice', value: 'voice.start-trip' });
    expect(sc.expectedPhrase).toBe('Начать поездку');
    expect(sc.aliases).toContain('Поехали');
    expect(sc.steps[0].kind).toBe('emit');
    expect(sc.steps[0].event.type).toBe('driver.trip.started');
    expect(sc.steps[0].event.payload).toEqual({ orderId: 1001 });
    expect(sc.steps[sc.steps.length - 1].kind).toBe('end');
  });

  test('CONTRACT-05: Scenario 4 - finish-trip (voice.finish-trip -> driver.trip.finished)', async () => {
    const sc = scenarioSet.scenarios.find((s: any) => s.id === 'finish-trip');
    expect(sc).toBeDefined();
    expect(sc.activation).toEqual({ type: 'voice', value: 'voice.finish-trip' });
    expect(sc.expectedPhrase).toBe('Завершить поездку');
    expect(sc.aliases).toContain('Поездка завершена');
    expect(sc.steps[0].kind).toBe('delay');
    expect(sc.steps[0].ms).toBe(300);
    expect(sc.steps[1].kind).toBe('emit');
    expect(sc.steps[1].event.type).toBe('driver.trip.finished');
    expect(sc.steps[1].event.payload).toEqual({ orderId: 1001, payment: 'cash' });
    expect(sc.steps[sc.steps.length - 1].kind).toBe('end');
  });

  test('CONTRACT-06: Scenario 5 - become-available (voice.available -> driver.available)', async () => {
    const sc = scenarioSet.scenarios.find((s: any) => s.id === 'become-available');
    expect(sc).toBeDefined();
    expect(sc.activation).toEqual({ type: 'voice', value: 'voice.available' });
    expect(sc.expectedPhrase).toBe('Готов к следующему заказу');
    expect(sc.aliases).toContain('Свободен');
    expect(sc.steps[0].kind).toBe('emit');
    expect(sc.steps[0].event.type).toBe('driver.available');
    expect(sc.steps[0].event.payload).toEqual({ driverStatus: 'available' });
    expect(sc.steps[sc.steps.length - 1].kind).toBe('end');
  });

});
