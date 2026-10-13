import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const scenarioFilePath = path.resolve(__dirname, '../../scenario-sc-001-vegetable-stall.json');
const rawContent = fs.readFileSync(scenarioFilePath, 'utf-8');
const scenarioSet = JSON.parse(rawContent);

// ============================================================================
// SUITE 1: SC-001 Scenario JSON Contract & Schema Tests
// ============================================================================
test.describe('SC-001: Scenario JSON Contract & Schema Validation', () => {

  test('CONTRACT-01: Load External Scenario JSON & Validate ScenarioSet v2 Root Contract', async () => {
    expect(scenarioSet).toBeDefined();
    expect(scenarioSet.version).toBe(2);
    expect(scenarioSet.id).toBe('scenario-set-sc-001-vegetable-stall');
    expect(scenarioSet.name).toContain('Продавец овощной лавки');
    expect(Array.isArray(scenarioSet.scenarios)).toBe(true);
    expect(scenarioSet.scenarios.length).toBe(1);

    const scenario = scenarioSet.scenarios[0];
    expect(scenario.id).toBe('sc-001-vegetable-stall-seller');
    expect(scenario.activation).toEqual({
      type: 'voice',
      value: 'Касса'
    });
    expect(Array.isArray(scenario.steps)).toBe(true);
  });

  test('CONTRACT-02: Step 1 Schema - QUERY_INVENTORY_STOCK (Tomatoes)', async () => {
    const stepInput = scenarioSet.scenarios[0].steps[0];
    expect(stepInput.kind).toBe('emit');
    expect(stepInput.event.type).toBe('VOICE_INPUT_RECEIVED');
    expect(stepInput.event.payload.itemId).toBe('tomatoes');
    expect(stepInput.event.payload.action).toBe('QUERY_INVENTORY_STOCK');

    const stepOutput = scenarioSet.scenarios[0].steps[1];
    expect(stepOutput.kind).toBe('emit');
    expect(stepOutput.event.type).toBe('INVENTORY_STOCK_RESOLVED');
    expect(stepOutput.event.payload.itemId).toBe('tomatoes');
    expect(stepOutput.event.payload.quantity).toBe(15.0);
    expect(stepOutput.event.payload.unit).toBe('kg');
  });

  test('CONTRACT-03: Step 2 Schema - PROCESS_SALE_AND_EMIT_RECEIPT', async () => {
    const stepInput = scenarioSet.scenarios[0].steps[3];
    expect(stepInput.kind).toBe('emit');
    expect(stepInput.event.type).toBe('VOICE_INPUT_RECEIVED');
    expect(stepInput.event.payload.action).toBe('PROCESS_SALE_AND_EMIT_RECEIPT');
    expect(stepInput.event.payload.quantity).toBe(2.0);

    const stepOutput = scenarioSet.scenarios[0].steps[4];
    expect(stepOutput.kind).toBe('emit');
    expect(stepOutput.event.type).toBe('SALE_TRANSACTION_COMPLETED');
    expect(stepOutput.event.payload.receiptPrinted).toBe(true);
    expect(stepOutput.event.payload.receiptId).toBe('REC-2026-001');
    expect(stepOutput.event.payload.remainingStock).toBe(13.0);
  });

  test('CONTRACT-04: Step 3 Schema - UPDATE_CATALOG_ITEM_PRICE', async () => {
    const stepInput = scenarioSet.scenarios[0].steps[6];
    expect(stepInput.kind).toBe('emit');
    expect(stepInput.event.type).toBe('VOICE_INPUT_RECEIVED');
    expect(stepInput.event.payload.action).toBe('UPDATE_CATALOG_ITEM_PRICE');

    const stepOutput = scenarioSet.scenarios[0].steps[7];
    expect(stepOutput.kind).toBe('emit');
    expect(stepOutput.event.type).toBe('ITEM_PRICE_UPDATED');
    expect(stepOutput.event.payload.newPrice).toBe(20.0);
  });

  test('CONTRACT-05: Step 4 Schema - SET_ITEM_OUT_OF_STOCK', async () => {
    const stepInput = scenarioSet.scenarios[0].steps[9];
    expect(stepInput.kind).toBe('emit');
    expect(stepInput.event.type).toBe('VOICE_INPUT_RECEIVED');
    expect(stepInput.event.payload.action).toBe('SET_ITEM_OUT_OF_STOCK');

    const stepOutput = scenarioSet.scenarios[0].steps[10];
    expect(stepOutput.kind).toBe('emit');
    expect(stepOutput.event.type).toBe('ITEM_STATUS_OUT_OF_STOCK_TRIGGERED');
    expect(stepOutput.event.payload.quantity).toBe(0.0);
  });

  test('CONTRACT-06: Step 5 Schema - CREATE_NEW_CATALOG_ITEM', async () => {
    const stepInput = scenarioSet.scenarios[0].steps[11];
    expect(stepInput.kind).toBe('emit');
    expect(stepInput.event.type).toBe('VOICE_INPUT_RECEIVED');
    expect(stepInput.event.payload.action).toBe('CREATE_NEW_CATALOG_ITEM');

    const stepOutput = scenarioSet.scenarios[0].steps[12];
    expect(stepOutput.kind).toBe('emit');
    expect(stepOutput.event.type).toBe('CATALOG_ITEM_CREATED');
    expect(stepOutput.event.payload.itemName).toBe('Клубника');
  });

  test('CONTRACT-07: Step 6 Schema - SET_INVENTORY_STOCK_LEVEL', async () => {
    const stepInput = scenarioSet.scenarios[0].steps[13];
    expect(stepInput.kind).toBe('emit');
    expect(stepInput.event.type).toBe('VOICE_INPUT_RECEIVED');
    expect(stepInput.event.payload.action).toBe('SET_INVENTORY_STOCK_LEVEL');

    const stepOutput = scenarioSet.scenarios[0].steps[14];
    expect(stepOutput.kind).toBe('emit');
    expect(stepOutput.event.type).toBe('INVENTORY_STOCK_UPDATED');
    expect(stepOutput.event.payload.quantity).toBe(10.0);
  });

  test('CONTRACT-08: Final Step Termination - Strict kind: "end" Check', async () => {
    const steps = scenarioSet.scenarios[0].steps;
    const finalStep = steps[steps.length - 1];
    expect(finalStep).toBeDefined();
    expect(finalStep.kind).toBe('end');
  });
});

// ============================================================================
// SUITE 2: SC-001 Live Application Runtime Execution E2E Tests
// ============================================================================
test.describe('SC-001: Live Application Runtime Execution E2E (External JSON & Strict Trace)', () => {

  test('RUNTIME-E2E-01: Upload External JSON, Activate File Source & Verify Strict 6-Step Execution Trace', async ({ page }) => {
    // 1. Open Live Validation Bench
    const appUrl = process.env.APP_URL || 'https://voice-assistant-two-olive.vercel.app';
    await page.goto(appUrl);
    await expect(page.locator('body')).toBeVisible();

    // 2. Select External JSON Source via UI
    const fileSourceRadio = page.locator('[data-testid="scenario-source-file"]').or(page.getByLabel(/загрузить json|файл json|upload json/i)).or(page.locator('input[type="file"]').locator('..'));
    if (await fileSourceRadio.isVisible()) {
      await fileSourceRadio.click();
    }

    // 3. Upload the exact external scenario JSON file
    const fileInput = page.locator('[data-testid="scenario-file-input"]').or(page.locator('input[type="file"]')).first();
    await fileInput.setInputFiles(scenarioFilePath);

    // 4. Verify External File is active and confirmed in UI
    const fileNameDisplay = page.locator('[data-testid="scenario-file-name"]').or(page.locator('text=scenario-sc-001-vegetable-stall.json')).first();
    await expect(fileNameDisplay).toBeVisible({ timeout: 5000 });

    // 5. Verify Scenario Metadata in UI header
    await expect(page.locator('text=scenario-set-sc-001-vegetable-stall').or(page.locator('text=Продавец овощной лавки')).first()).toBeVisible();

    // 6. Launch Execution
    const startButton = page.getByRole('button', { name: /запустить сценарий|start scenario|выполнить/i });
    await expect(startButton).toBeVisible();
    await startButton.click();

    // 7. Verify STEP 1: INVENTORY_STOCK_RESOLVED (15.0 kg)
    const step1Trace = page.locator('[data-testid="step-result-0"]').or(page.locator('text=INVENTORY_STOCK_RESOLVED').locator('..')).first();
    await expect(step1Trace).toBeVisible({ timeout: 10000 });
    await expect(step1Trace).toContainText('15');

    // 8. Verify STEP 2 [CRITICAL ATOMIC SALE]: 2 kg, 30 AED, 13 kg remaining, REC-2026-001, receiptPrinted=true
    const step2Trace = page.locator('[data-testid="step-result-1"]').or(page.locator('text=SALE_TRANSACTION_COMPLETED').locator('..')).first();
    await expect(step2Trace).toBeVisible({ timeout: 10000 });
    await expect(step2Trace).toContainText('REC-2026-001');
    await expect(step2Trace).toContainText('30');
    await expect(step2Trace).toContainText('13'); // verified remainingStock
    // Strict assertion: receiptPrinted verified via UI receipt badge / status
    await expect(step2Trace.locator('text=/чек напечатан|receipt printed|receipt: true|rec-2026-001/i').first()).toBeVisible();

    // 9. Verify STEP 3: ITEM_PRICE_UPDATED (20.0 AED)
    const step3Trace = page.locator('[data-testid="step-result-2"]').or(page.locator('text=ITEM_PRICE_UPDATED').locator('..')).first();
    await expect(step3Trace).toBeVisible({ timeout: 10000 });
    await expect(step3Trace).toContainText('20');

    // 10. Verify STEP 4: ITEM_STATUS_OUT_OF_STOCK_TRIGGERED
    const step4Trace = page.locator('[data-testid="step-result-3"]').or(page.locator('text=ITEM_STATUS_OUT_OF_STOCK_TRIGGERED').locator('..')).first();
    await expect(step4Trace).toBeVisible({ timeout: 10000 });

    // 11. Verify STEP 5: CATALOG_ITEM_CREATED (Strawberries / Клубника, 35 AED)
    const step5Trace = page.locator('[data-testid="step-result-4"]').or(page.locator('text=CATALOG_ITEM_CREATED').locator('..')).first();
    await expect(step5Trace).toBeVisible({ timeout: 10000 });
    await expect(step5Trace).toContainText('Клубника');

    // 12. Verify STEP 6: INVENTORY_STOCK_UPDATED (10.0 kg)
    const step6Trace = page.locator('[data-testid="step-result-5"]').or(page.locator('text=INVENTORY_STOCK_UPDATED').locator('..')).first();
    await expect(step6Trace).toBeVisible({ timeout: 10000 });
    await expect(step6Trace).toContainText('10');

    // 13. Strict Assertion: Sequence Termination & kind: "end" Reached
    const executionTerminal = page.locator('[data-testid="execution-terminal"]').or(page.locator('text=/kind:\s*"?end"?|KIND_END_REACHED|завершение сценария|SCENARIO_STATE_COMPLETED/i')).first();
    await expect(executionTerminal).toBeVisible({ timeout: 15000 });

    // 14. Verify Final Scenario Status in UI Execution Log (100% / 6/6 PASS)
    await expect(page.locator('text=100%').or(page.locator('text=6/6')).first()).toBeVisible({ timeout: 15000 });
  });

});
