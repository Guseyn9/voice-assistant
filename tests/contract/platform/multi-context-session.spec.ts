import { test, expect } from '@playwright/test';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';

test.describe('CONTRACT: PLATFORM-010 Multi-Context Session Manager Suite', () => {

  const identity = { ownerId: 'platform-010-test', sessionId: 'platform-010-session' };

  test('CONTRACT-01: Context has system-generated unique contextId', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);
    const ctxB = dm.createContext('ACCEPT_ORDER', { orderId: 1002 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);

    expect(typeof ctxA.contextId).toBe('string');
    expect(typeof ctxB.contextId).toBe('string');
    expect(ctxA.contextId).not.toBe(ctxB.contextId);
  });

  test('CONTRACT-02: Creation of second context preserves first context in WAITING_FOR_SLOT', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);
    const ctxB = dm.createContext('ACCEPT_ORDER', { orderId: 1002 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);

    expect(dm.getContext(ctxA.contextId, identity)?.status).toBe('WAITING_FOR_SLOT');
    expect(dm.getContext(ctxB.contextId, identity)?.status).toBe('WAITING_FOR_SLOT');
    expect(dm.listContexts(identity).length).toBe(2);
  });

  test('CONTRACT-03: Context switching preserves slots across independent contexts', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);
    const ctxB = dm.createContext('ACCEPT_ORDER', { orderId: 1002 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);

    dm.activateContext(ctxA.contextId, identity);
    expect(dm.getActiveState(identity)?.slots.orderId).toBe(1001);

    dm.activateContext(ctxB.contextId, identity);
    expect(dm.getActiveState(identity)?.slots.orderId).toBe(1002);
  });

  test('CONTRACT-04: Cancellation addresses strictly selected context', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);
    const ctxB = dm.createContext('ACCEPT_ORDER', { orderId: 1002 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);

    await dm.cancelContext(ctxA.contextId, identity);
    expect(dm.getContext(ctxA.contextId, identity)?.status).toBe('CANCELLED');
    expect(dm.getContext(ctxB.contextId, identity)?.status).toBe('WAITING_FOR_SLOT');
  });

  test('CONTRACT-05: Expiration addresses strictly selected context', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);
    const ctxB = dm.createContext('ACCEPT_ORDER', { orderId: 1002 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);

    await dm.expireContext(ctxA.contextId, identity);
    expect(dm.getContext(ctxA.contextId, identity)?.status).toBe('EXPIRED');
    expect(dm.getContext(ctxB.contextId, identity)?.status).toBe('WAITING_FOR_SLOT');
  });

  test('CONTRACT-06: Execution log contains contextId and strict actionType without fallback', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('ACCEPT_ORDER', { orderId: 1001, payment: 'card' }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);
    dm.createExecution(ctxA, identity, 'execution-platform-010-06');

    const logs = dm.getExecutionLogs(identity);
    expect(logs.length).toBe(1);
    expect(logs[0].contextId).toBe(ctxA.contextId);
    expect(logs[0].actionType).toBe('driver.order.accepted');
    expect(logs[0].payload).toEqual({ orderId: 1001, payment: 'card' });
  });

  test('CONTRACT-07: Idempotency is context-aware and does not conflict between orders', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('ACCEPT_ORDER', { orderId: 1001, payment: 'card' }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);
    const ctxB = dm.createContext('ACCEPT_ORDER', { orderId: 1002, payment: 'cash' }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);

    const executionA1 = dm.createExecution(ctxA, identity, 'execution-A');
    const executionA2 = dm.createExecution(ctxA, identity, 'execution-A');
    const executionB = dm.createExecution(ctxB, identity, 'execution-B');

    expect(executionA2.executionId).toBe(executionA1.executionId);
    expect(executionB.contextId).toBe(ctxB.contextId);
    const logs = dm.getExecutionLogs(identity);
    expect(logs.length).toBe(2);
    expect(logs.filter(log => log.contextId === ctxA.contextId)).toHaveLength(1);
    expect(logs.filter(log => log.contextId === ctxB.contextId)).toHaveLength(1);
  });

  test('CONTRACT-08: Runtime capacity policy rejects new context when maxActiveContexts is reached', async () => {
    const dm = new DialogueStateManager({ maxActiveContexts: 2 });
    dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);
    dm.createContext('ACCEPT_ORDER', { orderId: 1002 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);

    expect(() => {
      dm.createContext('ACCEPT_ORDER', { orderId: 1003 }, ['orderId', 'payment'], 'driver.order.accepted', {}, identity);
    }).toThrow(/REJECT_NEW_CONTEXT/);
  });

});
