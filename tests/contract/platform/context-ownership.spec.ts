import { test, expect } from '@playwright/test';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';

test.describe('CONTRACT: PLATFORM-013 Context Ownership & Session Isolation Suite', () => {

  const sessionA = { ownerId: 'driver-001', sessionId: 'session-A' };
  const sessionB = { ownerId: 'driver-002', sessionId: 'session-B' };
  const sessionA2 = { ownerId: 'driver-001', sessionId: 'session-A2' };

  test('CONTRACT-01: Context creation strictly preserves ownerId and sessionId', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, sessionA);

    expect(ctx.ownerId).toBe('driver-001');
    expect(ctx.sessionId).toBe('session-A');
    expect(ctx.contextId).toBeDefined();
  });

  test('CONTRACT-02: Operations succeed when ownerId and sessionId match exactly', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, sessionA);

    const res = await dm.fillSlot('payment', 'card', ctx.contextId, sessionA);
    expect(res).not.toBeNull();
    expect((res as any).success).toBe(true);
    expect((res as any).data.missingSlots).toEqual([]);
    expect((res as any).data.slots.payment).toBe('card');
  });

  test('CONTRACT-03: Cross-owner access returns CONTEXT_ACCESS_DENIED and state remains unchanged', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, sessionA);

    const res = await dm.fillSlot('payment', 'card', ctxA.contextId, sessionB);
    expect(res).toMatchObject({ success: false, error: 'CONTEXT_ACCESS_DENIED' });

    const fetched = dm.getContext(ctxA.contextId, sessionA);
    expect(fetched?.status).toBe('WAITING_FOR_SLOT');
    expect(fetched?.slots.payment).toBeUndefined();
  });

  test('CONTRACT-04: Cross-session access of same owner returns CONTEXT_ACCESS_DENIED', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, sessionA);

    const res = await dm.fillSlot('payment', 'card', ctxA.contextId, sessionA2);
    expect(res).toMatchObject({ success: false, error: 'CONTEXT_ACCESS_DENIED' });
  });

  test('CONTRACT-05: Candidate filtering completely excludes contexts of other sessions', async () => {
    const dm = new DialogueStateManager();
    dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, sessionA);
    dm.createContext('ACCEPT_ORDER', { orderId: 2001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, sessionB);

    const routeA = dm.resolveRouting('картой', ['payment'], sessionA);
    expect(routeA.status).toBe('RESOLVED');
    if (routeA.status === 'RESOLVED') {
      const target = dm.getContext(routeA.contextId, sessionA);
      expect(target?.slots.orderId).toBe(1001);
    }
  });

  test('CONTRACT-06: Action dispatch boundary strictly verifies session identity', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, sessionA);

    expect(() => {
      dm.createExecution(ctxA, sessionB);
    }).toThrow(/SECURITY_VIOLATION/);

    expect(dm.getExecutionLogs(sessionB).length).toBe(0);
  });

  test('CONTRACT-07: Cross-session cancellation is strictly denied', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, sessionA);

    const cancelRes = await dm.cancelContext(ctxA.contextId, sessionB);
    expect(cancelRes).toMatchObject({ success: false, error: 'CONTEXT_ACCESS_DENIED' });

    const fetched = dm.getContext(ctxA.contextId, sessionA);
    expect(fetched?.status).toBe('WAITING_FOR_SLOT');
  });

  test('CONTRACT-08: Zero information leakage on cross-owner context query', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, sessionA);

    const leakCheck = dm.getContext(ctxA.contextId, sessionB);
    expect(leakCheck).toBeUndefined();
  });

  test('CONTRACT-09: Mandatory SessionIdentity enforcement on all context APIs', async () => {
    const dm = new DialogueStateManager();

    expect(() => {
      (dm as any).createContext('ACCEPT_ORDER', {}, [], 'test', {});
    }).toThrow(/CONTRACT_VIOLATION/);

    expect(() => {
      (dm as any).listContexts();
    }).toThrow(/CONTRACT_VIOLATION/);

    expect(() => {
      (dm as any).getExecutionLogs();
    }).toThrow(/CONTRACT_VIOLATION/);
  });

  test('CONTRACT-10: listContexts and getExecutionLogs strictly isolate records by session', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('ACCEPT_ORDER', { orderId: 1001 }, ['orderId', 'payment'], 'driver.order.accepted', {}, sessionA);
    await dm.fillSlot('payment', 'card', ctxA.contextId, sessionA);

    const listB = dm.listContexts(sessionB);
    expect(listB.length).toBe(0);

    const logsB = dm.getExecutionLogs(sessionB);
    expect(logsB.length).toBe(0);

    dm.createExecution(ctxA, sessionA);
    const logsA = dm.getExecutionLogs(sessionA);
    expect(logsA.length).toBe(1);
    expect(logsA[0].ownerId).toBe('driver-001');
    expect(logsA[0].sessionId).toBe('session-A');
  });


  test('CONTRACT-11: Numeric context routing requires an exact token match', async () => {
    const dm = new DialogueStateManager();
    const first = dm.createContext(
      'ACCEPT_ORDER',
      { orderId: 1001 },
      ['payment'],
      'driver.order.accepted',
      {},
      sessionA
    );
    const second = dm.createContext(
      'ACCEPT_ORDER',
      { orderId: 10010 },
      ['payment'],
      'driver.order.accepted',
      {},
      sessionA
    );

    const route = dm.resolveRouting('10010', [], sessionA);
    expect(route).toMatchObject({ status: 'RESOLVED', contextId: second.contextId });
    expect(route.status === 'RESOLVED' && route.contextId).not.toBe(first.contextId);
  });

});
