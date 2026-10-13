import { test, expect } from '@playwright/test';
import { DialogueStateManager } from '../../../src/platform/dialogue-manager';

test.describe('CONTRACT: PLATFORM-016 Concurrency Control Suite', () => {

  const sessionA = { ownerId: 'driver-001', sessionId: 'session-A' };
  const sessionB = { ownerId: 'driver-002', sessionId: 'session-B' };

  test('CONTRACT-01: Sequential mutation increments version monotonically', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('PAYMENT', {}, ['slotA', 'slotB'], 'payment.action', {}, sessionA);
    expect(ctx.version).toBe(1);

    const m1 = await dm.fillSlot('slotA', 'valA', ctx.contextId, sessionA);
    expect(m1.success).toBe(true);
    expect(m1.version).toBe(2);

    const m2 = await dm.fillSlot('slotB', 'valB', ctx.contextId, sessionA);
    expect(m2.success).toBe(true);
    expect(m2.version).toBe(3);

    const fetched = dm.getContext(ctx.contextId, sessionA);
    expect(fetched?.version).toBe(3);
    expect(fetched?.slots.slotA).toBe('valA');
    expect(fetched?.slots.slotB).toBe('valB');
  });

  test('CONTRACT-02: Concurrent mutations on same context are serialized without lost updates', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('PAYMENT', {}, ['slotA', 'slotB', 'slotC'], 'payment.action', {}, sessionA);

    const [r1, r2, r3] = await Promise.all([
      dm.fillSlot('slotA', 'valA', ctx.contextId, sessionA),
      dm.fillSlot('slotB', 'valB', ctx.contextId, sessionA),
      dm.fillSlot('slotC', 'valC', ctx.contextId, sessionA)
    ]);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(true);

    const fetched = dm.getContext(ctx.contextId, sessionA);
    expect(fetched?.version).toBe(4);
    expect(fetched?.slots.slotA).toBe('valA');
    expect(fetched?.slots.slotB).toBe('valB');
    expect(fetched?.slots.slotC).toBe('valC');
  });

  test('CONTRACT-03: Version conflict detection prevents stale overwrites', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('PAYMENT', {}, ['slotA'], 'payment.action', {}, sessionA);

    await dm.fillSlot('slotA', 'valA', ctx.contextId, sessionA); // version becomes 2

    const staleRes = await dm.fillSlot('slotA', 'staleVal', ctx.contextId, sessionA, 1);
    expect(staleRes.success).toBe(false);
    expect(staleRes.error).toBe('CONTEXT_VERSION_CONFLICT');

    const fetched = dm.getContext(ctx.contextId, sessionA);
    expect(fetched?.slots.slotA).toBe('valA');
    expect(fetched?.version).toBe(2);
  });

  test('CONTRACT-04: Terminal state cannot be resurrected by subsequent mutation', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('PAYMENT', {}, ['slotA'], 'payment.action', {}, sessionA);

    const cancelRes = await dm.cancelContext(ctx.contextId, sessionA);
    expect(cancelRes.success).toBe(true);

    const fillRes = await dm.fillSlot('slotA', 'valA', ctx.contextId, sessionA);
    expect(fillRes.success).toBe(false);
    expect(fillRes.error).toBe('TERMINAL_STATE');

    const fetched = dm.getContext(ctx.contextId, sessionA);
    expect(fetched?.status).toBe('CANCELLED');
    expect(fetched?.slots.slotA).toBeUndefined();
  });

  test('CONTRACT-05: Race Voice (fillSlot) x System Event with declarative transition', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('PAYMENT', {}, ['slotA'], 'payment.action', {}, sessionA);

    const [resSystem, resVoice] = await Promise.all([
      dm.handleSystemEvent(ctx.contextId, { type: 'EXTERNAL_CANCEL', targetTransition: 'CANCEL' }, sessionA),
      dm.fillSlot('slotA', 'card', ctx.contextId, sessionA)
    ]);

    expect(resSystem.success).toBe(true);
    expect(resVoice.success).toBe(false);
    expect(resVoice.error).toBe('TERMINAL_STATE');

    const fetched = dm.getContext(ctx.contextId, sessionA);
    expect(fetched?.status).toBe('CANCELLED');
  });

  test('CONTRACT-06: Race Dispatch x Cancel proves deterministic winner and zero side-effects for loser', async () => {
    // Case 1: Dispatch arrives first -> completes -> subsequent cancel is rejected (1 side effect)
    let dispatcherCallsCase1 = 0;
    const dm1 = new DialogueStateManager({
      actionDispatcher: async (ev, ctx, ex) => {
        dispatcherCallsCase1++;
        await new Promise(r => setTimeout(r, 20));
        return { status: 'SUCCEEDED', executionId: ex.executionId, attempt: ex.attempt };
      }
    });
    const ctx1 = dm1.createContext('PAYMENT', { slotA: 'valA' }, ['slotA'], 'payment.action', {}, sessionA);
    const ex1 = dm1.createExecution(ctx1, sessionA);

    const pDispatch = dm1.dispatchAction(ex1.executionId, { slotA: 'valA' }, sessionA);
    const pCancel = dm1.cancelContext(ctx1.contextId, sessionA);

    const [dispRes1, cancelRes1] = await Promise.all([pDispatch, pCancel]);
    expect(dispRes1.status).toBe('SUCCEEDED');
    expect(cancelRes1.success).toBe(false);
    expect(cancelRes1.error).toBe('TERMINAL_STATE');
    expect(dm1.getContext(ctx1.contextId, sessionA)?.status).toBe('COMPLETED');
    expect(dispatcherCallsCase1).toBe(1);

    // Case 2: Cancel arrives first -> cancels -> subsequent dispatch throws CONTRACT_VIOLATION with 0 side effects
    let dispatcherCallsCase2 = 0;
    const dm2 = new DialogueStateManager({
      actionDispatcher: async (ev, ctx, ex) => {
        dispatcherCallsCase2++;
        return { status: 'SUCCEEDED', executionId: ex.executionId, attempt: ex.attempt };
      }
    });
    const ctx2 = dm2.createContext('PAYMENT', { slotA: 'valA' }, ['slotA'], 'payment.action', {}, sessionA);
    const ex2 = dm2.createExecution(ctx2, sessionA);

    const cancelFirst = dm2.cancelContext(ctx2.contextId, sessionA);
    const dispatchSecond = dm2.dispatchAction(ex2.executionId, { slotA: 'valA' }, sessionA);

    const cancelRes2 = await cancelFirst;
    expect(cancelRes2.success).toBe(true);
    await expect(dispatchSecond).rejects.toThrow(/CONTRACT_VIOLATION.*terminal status "CANCELLED"/);
    expect(dm2.getContext(ctx2.contextId, sessionA)?.status).toBe('CANCELLED');
    expect(dispatcherCallsCase2).toBe(0); // Strict zero side-effect proof
  });

  test('CONTRACT-07: Race TTL expiry x Action completion proved in both delivery orders (HIGH-1)', async () => {
    // Case 1: TTL arrives first -> EXPIRED -> subsequent Action rejected with 0 side effects
    let dispatcherCallsTtlFirst = 0;
    const dm1 = new DialogueStateManager({
      actionDispatcher: async (ev, ctx, ex) => {
        dispatcherCallsTtlFirst++;
        return { status: 'SUCCEEDED', executionId: ex.executionId, attempt: ex.attempt };
      }
    });
    const ctx1 = dm1.createContext('PAYMENT', { slotA: 'valA' }, ['slotA'], 'payment.action', {}, sessionA);
    const ex1 = dm1.createExecution(ctx1, sessionA);

    const expireFirst = dm1.expireContext(ctx1.contextId, sessionA);
    const dispatchSecond = dm1.dispatchAction(ex1.executionId, { slotA: 'valA' }, sessionA);

    const expiryRes1 = await expireFirst;
    expect(expiryRes1.success).toBe(true);
    await expect(dispatchSecond).rejects.toThrow(/CONTRACT_VIOLATION.*terminal status "EXPIRED"/);
    expect(dm1.getContext(ctx1.contextId, sessionA)?.status).toBe('EXPIRED');
    expect(dispatcherCallsTtlFirst).toBe(0);

    // Case 2: Action arrives first -> SUCCEEDED (COMPLETED) -> subsequent TTL gets TERMINAL_STATE (1 side effect)
    let dispatcherCallsActionFirst = 0;
    const dm2 = new DialogueStateManager({
      actionDispatcher: async (ev, ctx, ex) => {
        dispatcherCallsActionFirst++;
        await new Promise(r => setTimeout(r, 20));
        return { status: 'SUCCEEDED', executionId: ex.executionId, attempt: ex.attempt };
      }
    });
    const ctx2 = dm2.createContext('PAYMENT', { slotA: 'valA' }, ['slotA'], 'payment.action', {}, sessionA);
    const ex2 = dm2.createExecution(ctx2, sessionA);

    const dispatchFirst = dm2.dispatchAction(ex2.executionId, { slotA: 'valA' }, sessionA);
    const expireSecond = dm2.expireContext(ctx2.contextId, sessionA);

    const [dispRes2, expireRes2] = await Promise.all([dispatchFirst, expireSecond]);
    expect(dispRes2.status).toBe('SUCCEEDED');
    expect(expireRes2.success).toBe(false);
    expect(expireRes2.error).toBe('TERMINAL_STATE');
    expect(dm2.getContext(ctx2.contextId, sessionA)?.status).toBe('COMPLETED');
    expect(dispatcherCallsActionFirst).toBe(1);
  });

  test('CONTRACT-08: Unhandled system events do not mutate context state or bump version', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('PAYMENT', {}, ['slotA'], 'payment.action', {}, sessionA);
    expect(ctx.version).toBe(1);

    const res = await dm.handleSystemEvent(ctx.contextId, { type: 'SOME_UNKNOWN_NOTIFICATION', targetTransition: 'NONE' }, sessionA);
    expect(res.success).toBe(false);
    expect(res.error).toBe('SYSTEM_EVENT_NOT_HANDLED');

    const fetched = dm.getContext(ctx.contextId, sessionA);
    expect(fetched?.version).toBe(1);
    expect(fetched?.status).toBe('WAITING_FOR_SLOT');
  });

  test('CONTRACT-09: Independent contexts do not block each other', async () => {
    const dm = new DialogueStateManager();
    const ctxA = dm.createContext('INTENT_A', {}, ['slotA'], 'action.a', {}, sessionA);
    const ctxB = dm.createContext('INTENT_B', {}, ['slotB'], 'action.b', {}, sessionA);

    const start = Date.now();
    await Promise.all([
      dm.fillSlot('slotA', 'valA', ctxA.contextId, sessionA),
      dm.fillSlot('slotB', 'valB', ctxB.contextId, sessionA)
    ]);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(100);
    expect(dm.getContext(ctxA.contextId, sessionA)?.version).toBe(2);
    expect(dm.getContext(ctxB.contextId, sessionA)?.version).toBe(2);
  });

  test('CONTRACT-10: Cross-context isolation during heavy race', async () => {
    const dm = new DialogueStateManager();
    const ctx1 = dm.createContext('RACE_CTX', {}, ['slot1'], 'act.1', {}, sessionA);
    const ctx2 = dm.createContext('STABLE_CTX', { slot2: 'stable' }, ['slot2'], 'act.2', {}, sessionA);

    await Promise.all([
      dm.fillSlot('slot1', 'race1', ctx1.contextId, sessionA),
      dm.cancelContext(ctx1.contextId, sessionA),
      dm.expireContext(ctx1.contextId, sessionA)
    ]);

    const stable = dm.getContext(ctx2.contextId, sessionA);
    expect(stable?.version).toBe(1);
    expect(stable?.status).toBe('WAITING_FOR_SLOT');
    expect(stable?.slots.slot2).toBe('stable');
  });

  test('CONTRACT-11: Ownership enforcement prevents unauthorized mutations', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('PAYMENT', {}, ['slotA'], 'act', {}, sessionA);

    const alienRes = await dm.fillSlot('slotA', 'alienVal', ctx.contextId, sessionB);
    expect(alienRes.success).toBe(false);
    expect(alienRes.error).toBe('CONTEXT_ACCESS_DENIED');

    const fetched = dm.getContext(ctx.contextId, sessionA);
    expect(fetched?.version).toBe(1);
    expect(fetched?.slots.slotA).toBeUndefined();
  });

  test('CONTRACT-12: Concurrent duplicate execution creation remains strictly idempotent', async () => {
    const dm = new DialogueStateManager();
    const ctx = dm.createContext('PAYMENT', { orderId: 1001 }, ['orderId'], 'payment.act', {}, sessionA);

    const [e1, e2] = [
      dm.createExecution(ctx, sessionA, 'exec_idemp_1'),
      dm.createExecution(ctx, sessionA, 'exec_idemp_1')
    ];

    expect(e1.executionId).toBe(e2.executionId);
    expect(dm.getExecutionLogs(sessionA).length).toBe(1);
  });

});
