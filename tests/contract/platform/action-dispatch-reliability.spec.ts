import { test, expect } from '@playwright/test';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';

test.describe('CONTRACT: PLATFORM-015 Action Dispatch Reliability Suite', () => {

  const sessionA = { ownerId: 'driver-001', sessionId: 'session-A' };
  const sessionB = { ownerId: 'driver-002', sessionId: 'session-B' };

  test('CONTRACT-01: Execution creation yields unique executionId', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId'], 'order.accepted', {}, sessionA);
    const e1 = dm.createExecution(ctx, sessionA);
    const e2 = dm.createExecution(ctx, sessionA);
    expect(e1.executionId).not.toEqual(e2.executionId);
    expect(e1.status).toBe('PENDING');
  });

  test('CONTRACT-02: Retry preserves the same executionId across attempts', async () => {
    let attempts = 0;
    const dm = new DialogueStateManager({
      actionDispatcher: async (ev, ctx, ex) => {
        attempts++;
        if (attempts === 1) return { status: 'FAILED', executionId: ex.executionId, errorCode: 'TIMEOUT', attempt: ex.attempt };
        return { status: 'SUCCEEDED', executionId: ex.executionId, attempt: ex.attempt };
      }
    });

    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId'], 'order.accepted', {}, sessionA);
    const ex = dm.createExecution(ctx, sessionA);
    const res = await dm.dispatchAction(ex.executionId, { orderId: 1001 }, sessionA);

    expect(res.status).toBe('SUCCEEDED');
    expect(res.executionId).toBe(ex.executionId);
    expect(res.attempt).toBe(2);
  });

  test('CONTRACT-03: Retry preserves the exact idempotencyKey', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId'], 'order.accepted', {}, sessionA);
    const ex = dm.createExecution(ctx, sessionA);
    const originalKey = ex.idempotencyKey;

    await dm.dispatchAction(ex.executionId, { orderId: 1001 }, sessionA);
    const fetched = dm.getExecution(ex.executionId, sessionA);
    expect(fetched?.idempotencyKey).toBe(originalKey);
  });

  test('CONTRACT-04: Duplicate execution executes only once idempotently', async () => {
    let count = 0;
    const dm = new DialogueStateManager({
      actionDispatcher: async (ev, ctx, ex) => {
        count++;
        return { status: 'SUCCEEDED', executionId: ex.executionId, attempt: ex.attempt };
      }
    });

    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId'], 'order.accepted', {}, sessionA);
    const ex = dm.createExecution(ctx, sessionA);

    await dm.dispatchAction(ex.executionId, { orderId: 1001 }, sessionA);
    const second = await dm.dispatchAction(ex.executionId, { orderId: 1001 }, sessionA);

    expect(count).toBe(1);
    expect(second.status).toBe('SUCCEEDED');
  });

  test('CONTRACT-05: Dispatcher identity mismatch throws CONTRACT_VIOLATION', async () => {
    const dm = new DialogueStateManager({
      actionDispatcher: async (ev, ctx, ex) => {
        return { status: 'SUCCEEDED', executionId: 'mismatched_id', attempt: ex.attempt };
      }
    });
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId'], 'order.accepted', {}, sessionA);
    const ex = dm.createExecution(ctx, sessionA);

    await expect(async () => {
      await dm.dispatchAction(ex.executionId, { orderId: 1001 }, sessionA);
    }).rejects.toThrow(/CONTRACT_VIOLATION.*mismatched identity/);
  });

  test('CONTRACT-06: Payload mutation throws CONTRACT_VIOLATION', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId'], 'order.accepted', {}, sessionA);
    const ex = dm.createExecution(ctx, sessionA);

    await expect(async () => {
      await dm.dispatchAction(ex.executionId, { orderId: 9999 }, sessionA);
    }).rejects.toThrow(/CONTRACT_VIOLATION/);
  });

  test('CONTRACT-07: Retryable error triggers retry attempts up to maxAttempts', async () => {
    let retryCalls = 0;
    const dmRetry = new DialogueStateManager({
      retryPolicy: { maxAttempts: 3, retryableErrors: ['TIMEOUT'] },
      actionDispatcher: async (ev, ctx, ex) => { retryCalls++; return { status: 'FAILED', executionId: ex.executionId, errorCode: 'TIMEOUT', attempt: ex.attempt }; }
    });
    const ctx1 = dmRetry.createContext('ACCEPT_ORDER', { orderId: 1 }, ['orderId'], 'order.accepted', {}, sessionA);
    const ex1 = dmRetry.createExecution(ctx1, sessionA);
    const res1 = await dmRetry.dispatchAction(ex1.executionId, { orderId: 1 }, sessionA);
    expect(retryCalls).toBe(3);
    expect(res1.status).toBe('FAILED');
  });

  test('CONTRACT-08: Non-retryable error stops immediately with 1 attempt and blocks re-dispatch', async () => {
    let nonRetryCalls = 0;
    const dmNon = new DialogueStateManager({
      retryPolicy: { maxAttempts: 3, retryableErrors: ['TIMEOUT'] },
      actionDispatcher: async (ev, ctx, ex) => { nonRetryCalls++; return { status: 'FAILED', executionId: ex.executionId, errorCode: 'INVALID_ACTION', attempt: ex.attempt }; }
    });
    const ctx2 = dmNon.createContext('ACCEPT_ORDER', { orderId: 2 }, ['orderId'], 'order.accepted', {}, sessionA);
    const ex2 = dmNon.createExecution(ctx2, sessionA);
    const res2 = await dmNon.dispatchAction(ex2.executionId, { orderId: 2 }, sessionA);
    expect(nonRetryCalls).toBe(1);
    expect(res2.status).toBe('FAILED');

    // Attempting to re-dispatch terminal FAILED execution must throw CONTRACT_VIOLATION
    await expect(async () => {
      await dmNon.dispatchAction(ex2.executionId, { orderId: 2 }, sessionA);
    }).rejects.toThrow(/CONTRACT_VIOLATION.*Cannot dispatch terminal FAILED execution/);
  });

  test('CONTRACT-09: Timeout without confirmation returns UNKNOWN and blocks direct re-dispatch', async () => {
    const dm = new DialogueStateManager({
      actionDispatcher: async (ev, ctx, ex) => ({ status: 'UNKNOWN', executionId: ex.executionId, errorCode: 'NO_CONFIRMATION', attempt: ex.attempt })
    });
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId'], 'order.accepted', {}, sessionA);
    const ex = dm.createExecution(ctx, sessionA);
    const res = await dm.dispatchAction(ex.executionId, { orderId: 1001 }, sessionA);

    expect(res.status).toBe('UNKNOWN');
    expect(res.errorCode).toBe('NO_CONFIRMATION');

    // UNKNOWN state blocks direct dispatchAction without reconciliation
    await expect(async () => {
      await dm.dispatchAction(ex.executionId, { orderId: 1001 }, sessionA);
    }).rejects.toThrow(/CONTRACT_VIOLATION.*UNKNOWN state.*reconciliation is required/);
  });

  test('CONTRACT-10: UNKNOWN does not mark context as COMPLETED', async () => {
    const dm = new DialogueStateManager({
      actionDispatcher: async (ev, ctx, ex) => ({ status: 'UNKNOWN', executionId: ex.executionId, errorCode: 'NO_CONFIRMATION', attempt: ex.attempt })
    });
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId'], 'order.accepted', {}, sessionA);
    const ex = dm.createExecution(ctx, sessionA);
    await dm.dispatchAction(ex.executionId, { orderId: 1001 }, sessionA);

    const fetchedCtx = dm.getContext(ctx.contextId, sessionA);
    expect(fetchedCtx?.status).not.toBe('COMPLETED');
  });

  test('CONTRACT-11: Explicit reconciliation transitions UNKNOWN to SUCCEEDED and completes context', async () => {
    const dm = new DialogueStateManager({
      actionDispatcher: async (ev, ctx, ex) => ({ status: 'UNKNOWN', executionId: ex.executionId, errorCode: 'NO_CONFIRMATION', attempt: ex.attempt })
    });
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId'], 'order.accepted', {}, sessionA);
    const ex = dm.createExecution(ctx, sessionA);
    await dm.dispatchAction(ex.executionId, { orderId: 1001 }, sessionA);

    const reconciled = await dm.reconcileExecution(ex.executionId, 'SUCCEEDED', sessionA);
    expect(reconciled.status).toBe('SUCCEEDED');
    expect(dm.getContext(ctx.contextId, sessionA)?.status).toBe('COMPLETED');
  });

  test('CONTRACT-12: Concurrent duplicate dispatch produces single side effect', async () => {
    let sideEffects = 0;
    const dm = new DialogueStateManager({
      actionDispatcher: async (ev, ctx, ex) => {
        sideEffects++;
        await new Promise(r => setTimeout(r, 15));
        return { status: 'SUCCEEDED', executionId: ex.executionId, attempt: ex.attempt };
      }
    });
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId'], 'order.accepted', {}, sessionA);
    const ex = dm.createExecution(ctx, sessionA);

    await Promise.all([
      dm.dispatchAction(ex.executionId, { orderId: 1001 }, sessionA),
      dm.dispatchAction(ex.executionId, { orderId: 1001 }, sessionA)
    ]);
    expect(sideEffects).toBe(1);
  });

  test('CONTRACT-13: Execution cannot be created for terminal context states', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId'], 'order.accepted', {}, sessionA);
    await dm.cancelContext(ctx.contextId, sessionA);

    expect(() => {
      dm.createExecution(ctx, sessionA);
    }).toThrow(/CONTRACT_VIOLATION.*Cannot create execution for terminal context/);
  });

  test('CONTRACT-14: Missing actionDispatcher returns FAILED instead of silent success', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId'], 'order.accepted', {}, sessionA);
    const ex = dm.createExecution(ctx, sessionA);

    const res = await dm.dispatchAction(ex.executionId, { orderId: 1001 }, sessionA);
    expect(res.status).toBe('FAILED');
    expect(res.errorCode).toBe('DISPATCHER_NOT_CONFIGURED');
    expect(dm.getContext(ctx.contextId, sessionA)?.status).not.toBe('COMPLETED');
  });

  test('CONTRACT-15: Execution correlation contains ownerId/sessionId/contextId', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId'], 'order.accepted', {}, sessionA);
    const ex = dm.createExecution(ctx, sessionA);

    expect(ex.ownerId).toBe('driver-001');
    expect(ex.sessionId).toBe('session-A');
    expect(ex.contextId).toBe(ctx.contextId);
  });

  test('CONTRACT-16: Distinct executions get unique idempotency keys', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('ORDER', { orderId: 1001 }, ['orderId'], 'order.step1', {}, sessionA);
    const ex1 = dm.createExecution(ctx, sessionA);
    const ex2 = dm.createExecution(ctx, sessionA);

    expect(ex1.idempotencyKey).not.toEqual(ex2.idempotencyKey);
  });

});
