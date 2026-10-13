export interface SessionIdentity {
  ownerId: string;
  sessionId: string;
}

export interface OfferDefinition {
  offerId: string;
  index: number; // 1, 2, 3...
  driver: string;
  vehicleType: string;
  etaMinutes: number;
  price: number;
  distanceKm: number;
  status: 'AVAILABLE' | 'UNAVAILABLE';
}

export interface DialogueContext {
  contextId: string;
  version: number;
  ownerId: string;
  sessionId: string;
  intent: string;
  slots: Record<string, any>;
  missingSlots: string[];
  status: 'WAITING_FOR_SLOT' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'DISPATCHING';
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  actionType: string;
  scenarioId?: string;
  clarificationPrompts?: Record<string, string>;
  clarificationPrompt?: string;
  offers?: OfferDefinition[];
}

export type ExecutionStatus = 'PENDING' | 'DISPATCHING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export interface ActionExecution {
  executionId: string;
  idempotencyKey: string;
  ownerId: string;
  sessionId: string;
  contextId: string;
  scenarioId: string;
  intent: string;
  actionType: string;
  payload: Record<string, any>;
  status: ExecutionStatus;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  errorCode?: string;
  event?: { type: string; payload: Record<string, any> };
}

export type DispatchResult =
  | { status: 'SUCCEEDED'; executionId: string; attempt: number }
  | { status: 'FAILED'; executionId: string; errorCode: string; attempt: number }
  | { status: 'UNKNOWN'; executionId: string; errorCode: string; attempt: number };

export interface RetryPolicy {
  maxAttempts: number;
  retryableErrors: string[];
}

export type ActionDispatcher = (
  event: { type: string; payload: Record<string, any> },
  context: DialogueContext,
  execution: ActionExecution
) => Promise<DispatchResult>;

export interface DialogueManagerConfig {
  maxActiveContexts?: number;
  defaultTtlMs?: number;
  actionDispatcher?: ActionDispatcher;
  retryPolicy?: RetryPolicy;
  enableAutoExpiryScheduler?: boolean;
}

export type RoutingResult =
  | { status: 'RESOLVED'; contextId: string }
  | { status: 'AMBIGUOUS_CONTEXT'; candidateContextIds: string[] }
  | { status: 'NO_MATCH' }
  | { status: 'CONTEXT_ACCESS_DENIED' };

export type MutationResult<T> =
  | { success: true; data: T; version: number }
  | { success: false; error: 'CONTEXT_VERSION_CONFLICT' | 'TERMINAL_STATE' | 'CONTEXT_NOT_FOUND' | 'CONTEXT_ACCESS_DENIED' | 'SYSTEM_EVENT_NOT_HANDLED' | 'MUTATION_REJECTED'; message: string };

export interface SystemEventDescriptor {
  type: string;
  targetTransition?: 'COMPLETE' | 'CANCEL' | 'NONE';
  payload?: Record<string, any>;
}

export class DialogueStateManager {
  private contexts: Map<string, DialogueContext> = new Map();
  private activeContextId: string | null = null;
  private executions: Map<string, ActionExecution> = new Map();
  private maxActiveContexts: number;
  private defaultTtlMs: number;
  private actionDispatcher?: ActionDispatcher;
  private retryPolicy: RetryPolicy;
  private timerMap: Map<string, any> = new Map();
  private enableAutoExpiryScheduler: boolean;

  // Per-Context Serialization Queues
  private contextMutationQueues: Map<string, Promise<any>> = new Map();

  constructor(configOrTimeout: DialogueManagerConfig | number = {}) {
    if (typeof configOrTimeout === 'number') {
      this.defaultTtlMs = configOrTimeout;
      this.maxActiveContexts = 50;
      this.enableAutoExpiryScheduler = true;
      this.retryPolicy = { maxAttempts: 3, retryableErrors: ['TIMEOUT', 'NETWORK_ERROR', 'TEMPORARY_UNAVAILABLE'] };
    } else {
      this.maxActiveContexts = configOrTimeout.maxActiveContexts ?? 50;
      this.defaultTtlMs = configOrTimeout.defaultTtlMs ?? 300000;
      this.actionDispatcher = configOrTimeout.actionDispatcher;
      this.retryPolicy = configOrTimeout.retryPolicy ?? { maxAttempts: 3, retryableErrors: ['TIMEOUT', 'NETWORK_ERROR', 'TEMPORARY_UNAVAILABLE'] };
      this.enableAutoExpiryScheduler = configOrTimeout.enableAutoExpiryScheduler ?? true;
    }
    this.reset();
  }

  public hasActionDispatcher(): boolean {
    return Boolean(this.actionDispatcher);
  }

  public setActionDispatcher(dispatcher: ActionDispatcher): void {
    this.actionDispatcher = dispatcher;
  }

  public reset(): void {
    for (const timer of this.timerMap.values()) {
      clearTimeout(timer);
    }
    this.timerMap.clear();
    this.contexts.clear();
    this.activeContextId = null;
    this.executions.clear();
    this.contextMutationQueues.clear();
  }

  private validateIdentity(identity: SessionIdentity): void {
    if (!identity || typeof identity.ownerId !== 'string' || typeof identity.sessionId !== 'string' || !identity.ownerId || !identity.sessionId) {
      throw new Error('CONTRACT_VIOLATION: SessionIdentity with non-empty ownerId and sessionId is strictly required');
    }
  }

  public getActiveContextId(): string | null {
    return this.activeContextId;
  }

  public getActiveState(identity: SessionIdentity): DialogueContext | null {
    this.validateIdentity(identity);
    if (!this.activeContextId) return null;
    const ctx = this.contexts.get(this.activeContextId);
    if (!ctx || ctx.ownerId !== identity.ownerId || ctx.sessionId !== identity.sessionId) {
      return null;
    }
    return {
      ...ctx,
      slots: { ...ctx.slots },
      missingSlots: [...ctx.missingSlots],
      offers: ctx.offers ? [...ctx.offers.map(o => ({ ...o }))] : undefined
    };
  }

  public getContext(contextId: string, identity: SessionIdentity): DialogueContext | undefined {
    this.validateIdentity(identity);
    const ctx = this.contexts.get(contextId);
    if (!ctx) return undefined;
    if (ctx.ownerId !== identity.ownerId || ctx.sessionId !== identity.sessionId) {
      return undefined;
    }
    return {
      ...ctx,
      slots: { ...ctx.slots },
      missingSlots: [...ctx.missingSlots],
      offers: ctx.offers ? [...ctx.offers.map(o => ({ ...o }))] : undefined
    };
  }

  public listContexts(identity: SessionIdentity): DialogueContext[] {
    this.validateIdentity(identity);
    return Array.from(this.contexts.values())
      .filter(c => c.ownerId === identity.ownerId && c.sessionId === identity.sessionId)
      .map(c => ({
        ...c,
        slots: { ...c.slots },
        missingSlots: [...c.missingSlots],
        offers: c.offers ? [...c.offers.map(o => ({ ...o }))] : undefined
      }));
  }

  public activateContext(contextId: string, identity: SessionIdentity): boolean {
    this.validateIdentity(identity);
    const ctx = this.contexts.get(contextId);
    if (!ctx || ctx.ownerId !== identity.ownerId || ctx.sessionId !== identity.sessionId) {
      return false;
    }
    this.activeContextId = contextId;
    return true;
  }

  public setOffersForContext(contextId: string, offers: OfferDefinition[], identity: SessionIdentity): boolean {
    this.validateIdentity(identity);
    const ctx = this.contexts.get(contextId);
    if (!ctx || ctx.ownerId !== identity.ownerId || ctx.sessionId !== identity.sessionId) {
      return false;
    }
    ctx.offers = [...offers.map(o => ({ ...o }))];
    ctx.version += 1;
    ctx.updatedAt = Date.now();
    return true;
  }

  // --- Per-Context Serialization & Queue Lifecycle Management ---

  public async executeSerializedMutation<T>(
    contextId: string,
    expectedVersion: number | undefined,
    identity: SessionIdentity,
    mutationFn: (ctx: DialogueContext) => Promise<{ result: T; targetStatus?: DialogueContext['status'] } | null>
  ): Promise<MutationResult<T>> {
    this.validateIdentity(identity);

    const prevPromise = this.contextMutationQueues.get(contextId) || Promise.resolve();

    const mutationPromise = prevPromise.then(async () => {
      const ctx = this.contexts.get(contextId);
      if (!ctx) {
        return { success: false as const, error: 'CONTEXT_NOT_FOUND' as const, message: `Context "${contextId}" not found` };
      }

      if (ctx.ownerId !== identity.ownerId || ctx.sessionId !== identity.sessionId) {
        return { success: false as const, error: 'CONTEXT_ACCESS_DENIED' as const, message: 'Cross-session context mutation is prohibited' };
      }

      // Optimistic CAS version check
      if (expectedVersion !== undefined && ctx.version !== expectedVersion) {
        return {
          success: false as const,
          error: 'CONTEXT_VERSION_CONFLICT' as const,
          message: `Version conflict for context "${contextId}". Expected: ${expectedVersion}, Current: ${ctx.version}`
        };
      }

      // Terminal State Protection
      if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(ctx.status)) {
        return {
          success: false as const,
          error: 'TERMINAL_STATE' as const,
          message: `Context "${contextId}" is in terminal state "${ctx.status}" and cannot be resurrected or modified`
        };
      }

      const outcome = await mutationFn(ctx);
      if (!outcome) {
        return { success: false as const, error: 'MUTATION_REJECTED' as const, message: 'Mutation rejected by predicate' };
      }

      // Atomic version increment
      ctx.version += 1;
      ctx.updatedAt = Date.now();
      if (outcome.targetStatus) {
        ctx.status = outcome.targetStatus;
      }
      if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(ctx.status)) {
        if (this.timerMap.has(contextId)) {
          clearTimeout(this.timerMap.get(contextId));
          this.timerMap.delete(contextId);
        }
        if (this.activeContextId === contextId) {
          this.activeContextId = null;
        }
      }

      return {
        success: true as const,
        data: outcome.result,
        version: ctx.version
      };
    }).catch(err => {
      return { success: false as const, error: 'MUTATION_REJECTED' as const, message: err?.message || 'Unknown error' };
    }).finally(() => {
      if (this.contextMutationQueues.get(contextId) === mutationPromise) {
        this.contextMutationQueues.delete(contextId);
      }
    });

    this.contextMutationQueues.set(contextId, mutationPromise);
    return mutationPromise;
  }

  private scheduleTtlTimer(contextId: string, ttlMs: number): void {
    if (!this.enableAutoExpiryScheduler) return;

    if (this.timerMap.has(contextId)) {
      clearTimeout(this.timerMap.get(contextId));
    }

    const timer = setTimeout(() => {
      const ctx = this.contexts.get(contextId);
      if (ctx) {
        const identity: SessionIdentity = { ownerId: ctx.ownerId, sessionId: ctx.sessionId };
        this.expireContext(contextId, identity);
      }
      this.timerMap.delete(contextId);
    }, ttlMs);

    // In Node-based test runners, expiry timers must not keep the process alive
    // after the suite has completed. Browsers do not expose unref(), so this is
    // a no-op there and leaves normal runtime expiry unchanged.
    (timer as any).unref?.();
    this.timerMap.set(contextId, timer);
  }

  public createContext(
    intent: string,
    initialSlots: Record<string, any>,
    requiredSlots: string[],
    actionType: string,
    clarificationPrompts: Record<string, string>,
    identity: SessionIdentity,
    scenarioId?: string,
    initialOffers?: OfferDefinition[]
  ): DialogueContext {
    this.validateIdentity(identity);
    if (!actionType) {
      throw new Error('CONTRACT_VIOLATION: actionType is strictly required for createContext');
    }

    for (const [key, value] of Object.entries(initialSlots)) {
      if (value !== undefined) {
        const existing = Array.from(this.contexts.values()).find(
          c =>
            c.ownerId === identity.ownerId &&
            c.sessionId === identity.sessionId &&
            c.intent === intent &&
            c.slots[key] === value &&
            c.status === 'WAITING_FOR_SLOT'
        );
        if (existing) {
          this.activeContextId = existing.contextId;
          return {
            ...existing,
            slots: { ...existing.slots },
            missingSlots: [...existing.missingSlots],
            offers: existing.offers ? [...existing.offers.map(o => ({ ...o }))] : undefined
          };
        }
      }
    }

    const activeCount = Array.from(this.contexts.values()).filter(
      c => c.ownerId === identity.ownerId && c.sessionId === identity.sessionId && c.status === 'WAITING_FOR_SLOT'
    ).length;

    if (activeCount >= this.maxActiveContexts) {
      throw new Error(`REJECT_NEW_CONTEXT: Runtime policy max active contexts (${this.maxActiveContexts}) reached`);
    }

    const contextId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const slots = { ...initialSlots };
    const missingSlots = requiredSlots.filter(s => slots[s] === undefined);
    const now = Date.now();

    const firstMissing = missingSlots[0];
    const newContext: DialogueContext = {
      contextId,
      version: 1,
      ownerId: identity.ownerId,
      sessionId: identity.sessionId,
      intent,
      slots,
      missingSlots,
      status: 'WAITING_FOR_SLOT',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.defaultTtlMs,
      actionType,
      scenarioId,
      clarificationPrompts,
      clarificationPrompt: firstMissing ? clarificationPrompts[firstMissing] : undefined,
      offers: initialOffers ? [...initialOffers.map(o => ({ ...o }))] : undefined
    };

    this.contexts.set(contextId, newContext);
    this.activeContextId = contextId;

    if (missingSlots.length > 0) {
      this.scheduleTtlTimer(contextId, this.defaultTtlMs);
    }

    return {
      ...newContext,
      slots: { ...newContext.slots },
      missingSlots: [...newContext.missingSlots],
      offers: newContext.offers ? [...newContext.offers.map(o => ({ ...o }))] : undefined
    };
  }

  public resolveRouting(
    phrase: string,
    extractedSlotKeys: string[],
    identity: SessionIdentity
  ): RoutingResult {
    this.validateIdentity(identity);
    const text = phrase.toLowerCase();
    const tokens = text.split(/\s+/);

    let foreignContextMatched = false;
    for (const ctx of this.contexts.values()) {
      if (ctx.status !== 'WAITING_FOR_SLOT') continue;

      for (const [slotKey, slotVal] of Object.entries(ctx.slots)) {
        if (slotVal === undefined || slotVal === null) continue;
        const valStr = String(slotVal).toLowerCase();
        const numericSlotValue = /^-?\d+(?:\.\d+)?$/.test(valStr);
        const valueMentioned = numericSlotValue
          ? tokens.includes(valStr)
          : tokens.includes(valStr) || text.includes(valStr);

        if (valueMentioned) {
          if (ctx.ownerId !== identity.ownerId || ctx.sessionId !== identity.sessionId) {
            foreignContextMatched = true;
            continue;
          }
          this.activeContextId = ctx.contextId;
          return { status: 'RESOLVED', contextId: ctx.contextId };
        }
      }
    }

    if (foreignContextMatched) {
      return { status: 'CONTEXT_ACCESS_DENIED' };
    }

    const candidates = Array.from(this.contexts.values()).filter(ctx => {
      if (ctx.ownerId !== identity.ownerId || ctx.sessionId !== identity.sessionId) return false;
      if (ctx.status !== 'WAITING_FOR_SLOT') return false;
      return extractedSlotKeys.some(key => ctx.missingSlots.includes(key));
    });

    if (candidates.length === 1) {
      this.activeContextId = candidates[0].contextId;
      return { status: 'RESOLVED', contextId: candidates[0].contextId };
    }

    if (candidates.length > 1) {
      return {
        status: 'AMBIGUOUS_CONTEXT',
        candidateContextIds: candidates.map(c => c.contextId)
      };
    }

    return { status: 'NO_MATCH' };
  }

  public async fillSlot(
    slotName: string,
    value: any,
    contextId: string,
    identity: SessionIdentity,
    expectedVersion?: number
  ): Promise<MutationResult<DialogueContext>> {
    const targetId = contextId || this.activeContextId;
    if (!targetId) {
      return { success: false, error: 'CONTEXT_NOT_FOUND', message: 'No target contextId specified' };
    }

    return this.executeSerializedMutation(targetId, expectedVersion, identity, async (ctx) => {
      if (ctx.status !== 'WAITING_FOR_SLOT') {
        return null;
      }

      ctx.slots[slotName] = value;
      ctx.missingSlots = ctx.missingSlots.filter(s => s !== slotName);

      if (ctx.missingSlots.length === 0) {
        ctx.clarificationPrompt = undefined;
        if (this.timerMap.has(ctx.contextId)) {
          clearTimeout(this.timerMap.get(ctx.contextId));
          this.timerMap.delete(ctx.contextId);
        }
      } else {
        const nextMissing = ctx.missingSlots[0];
        ctx.clarificationPrompt = ctx.clarificationPrompts?.[nextMissing] || `Укажите ${nextMissing}`;
        this.scheduleTtlTimer(ctx.contextId, this.defaultTtlMs);
      }

      return {
        result: {
          ...ctx,
          slots: { ...ctx.slots },
          missingSlots: [...ctx.missingSlots],
          offers: ctx.offers ? [...ctx.offers.map(o => ({ ...o }))] : undefined
        }
      };
    });
  }

  public async cancelContext(
    contextId: string,
    identity: SessionIdentity,
    expectedVersion?: number
  ): Promise<MutationResult<boolean>> {
    const targetId = contextId || this.activeContextId;
    if (!targetId) {
      return { success: false, error: 'CONTEXT_NOT_FOUND', message: 'No target contextId specified' };
    }

    return this.executeSerializedMutation(targetId, expectedVersion, identity, async (ctx) => {
      if (this.timerMap.has(ctx.contextId)) {
        clearTimeout(this.timerMap.get(ctx.contextId));
        this.timerMap.delete(ctx.contextId);
      }
      return {
        result: true,
        targetStatus: 'CANCELLED'
      };
    });
  }

  public async expireContext(
    contextId: string,
    identity: SessionIdentity,
    expectedVersion?: number
  ): Promise<MutationResult<boolean>> {
    return this.executeSerializedMutation(contextId, expectedVersion, identity, async (ctx) => {
      if (ctx.status !== 'WAITING_FOR_SLOT') {
        return null;
      }
      if (this.timerMap.has(contextId)) {
        clearTimeout(this.timerMap.get(contextId));
        this.timerMap.delete(contextId);
      }
      return {
        result: true,
        targetStatus: 'EXPIRED'
      };
    });
  }

  public async handleSystemEvent(
    contextId: string,
    event: SystemEventDescriptor | string,
    identity: SessionIdentity,
    expectedVersion?: number
  ): Promise<MutationResult<{ handled: boolean; eventType: string; context: DialogueContext }>> {
    const descriptor: SystemEventDescriptor = typeof event === 'string'
      ? { type: event, targetTransition: 'NONE' }
      : event;

    if (!descriptor.targetTransition || descriptor.targetTransition === 'NONE') {
      return {
        success: false,
        error: 'SYSTEM_EVENT_NOT_HANDLED',
        message: `System event "${descriptor.type}" specifies no state transition and was ignored without mutation.`
      };
    }

    return this.executeSerializedMutation(contextId, expectedVersion, identity, async (ctx) => {
      if (descriptor.targetTransition === 'CANCEL') {
        if (this.timerMap.has(ctx.contextId)) {
          clearTimeout(this.timerMap.get(ctx.contextId));
          this.timerMap.delete(ctx.contextId);
        }
        ctx.status = 'CANCELLED';
      } else if (descriptor.targetTransition === 'COMPLETE') {
        if (this.timerMap.has(ctx.contextId)) {
          clearTimeout(this.timerMap.get(ctx.contextId));
          this.timerMap.delete(ctx.contextId);
        }
        ctx.status = 'COMPLETED';
      }

      return {
        result: {
          handled: true,
          eventType: descriptor.type,
          context: {
            ...ctx,
            slots: { ...ctx.slots },
            missingSlots: [...ctx.missingSlots],
            offers: ctx.offers ? [...ctx.offers.map(o => ({ ...o }))] : undefined
          }
        }
      };
    });
  }

  public createExecution(
    ctx: DialogueContext,
    identity: SessionIdentity,
    providedExecutionId?: string,
    payloadOverride?: Record<string, any>
  ): ActionExecution {
    this.validateIdentity(identity);
    if (ctx.ownerId !== identity.ownerId || ctx.sessionId !== identity.sessionId) {
      throw new Error('SECURITY_VIOLATION: Cannot create execution for foreign context');
    }

    // The caller may hold a stale context snapshot. Authorize and validate the
    // current stored state, not the snapshot, before creating an execution.
    const authoritativeCtx = this.contexts.get(ctx.contextId);
    if (!authoritativeCtx) {
      throw new Error(`CONTRACT_VIOLATION: Cannot create execution for missing context "${ctx.contextId}"`);
    }
    if (authoritativeCtx.ownerId !== identity.ownerId || authoritativeCtx.sessionId !== identity.sessionId) {
      throw new Error('SECURITY_VIOLATION: Cannot create execution for foreign context');
    }
    if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(authoritativeCtx.status)) {
      throw new Error(`CONTRACT_VIOLATION: Cannot create execution for terminal context (${authoritativeCtx.status})`);
    }

    const executionId = providedExecutionId || `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (this.executions.has(executionId)) {
      const existing = this.executions.get(executionId)!;
      const sameOwner = existing.ownerId === identity.ownerId && existing.sessionId === identity.sessionId;
      const sameCtx = existing.contextId === ctx.contextId;
      const sameAction = existing.actionType === authoritativeCtx.actionType;
      const expectedPayload = { ...(payloadOverride || {}), ...authoritativeCtx.slots };
      const samePayload = JSON.stringify(existing.payload) === JSON.stringify(expectedPayload);

      if (sameOwner && sameCtx && sameAction && samePayload) {
        return existing;
      }
      throw new Error(`CONTRACT_VIOLATION: Cannot overwrite existing executionId "${executionId}" with different execution data`);
    }

    const idempotencyKey = `idemp_${authoritativeCtx.contextId}_${executionId}_${authoritativeCtx.actionType}`;
    const now = Date.now();

    const execution: ActionExecution = {
      executionId,
      idempotencyKey,
      ownerId: identity.ownerId,
      sessionId: identity.sessionId,
      contextId: authoritativeCtx.contextId,
      scenarioId: authoritativeCtx.scenarioId || 'sc-default',
      intent: authoritativeCtx.intent,
      actionType: authoritativeCtx.actionType,
      payload: { ...(payloadOverride || {}), ...authoritativeCtx.slots },
      status: 'PENDING',
      attempt: 0,
      createdAt: now,
      updatedAt: now
    };

    this.executions.set(executionId, execution);
    return execution;
  }

  public async dispatchAction(
    executionId: string,
    payload: Record<string, any>,
    identity: SessionIdentity
  ): Promise<DispatchResult> {
    this.validateIdentity(identity);
    const execution = this.executions.get(executionId);
    if (!execution) {
      throw new Error(`CONTRACT_VIOLATION: Execution "${executionId}" not found`);
    }

    if (execution.ownerId !== identity.ownerId || execution.sessionId !== identity.sessionId) {
      throw new Error('SECURITY_VIOLATION: Cannot dispatch cross-session execution');
    }

    if (JSON.stringify(execution.payload) !== JSON.stringify(payload)) {
      throw new Error('CONTRACT_VIOLATION: Payload cannot be mutated for same executionId');
    }

    if (execution.status === 'SUCCEEDED') {
      return { status: 'SUCCEEDED', executionId: execution.executionId, attempt: execution.attempt };
    }

    if (execution.status === 'FAILED') {
      throw new Error(`CONTRACT_VIOLATION: Cannot dispatch terminal FAILED execution "${executionId}". A new executionId must be created.`);
    }

    if (execution.status === 'UNKNOWN') {
      throw new Error(`CONTRACT_VIOLATION: Execution "${executionId}" is in UNKNOWN state. Explicit reconciliation is required before retry.`);
    }

    if (execution.status === 'DISPATCHING') {
      return { status: 'UNKNOWN', executionId: execution.executionId, errorCode: 'ALREADY_IN_PROGRESS', attempt: execution.attempt };
    }

    const contextId = execution.contextId;

    const prevPromise = this.contextMutationQueues.get(contextId) || Promise.resolve();

    const dispatchPromise = prevPromise.then(async () => {
      // Re-check after acquiring the per-context queue. Concurrent callers may
      // have observed PENDING before the first dispatch completed.
      if (execution.status === 'SUCCEEDED') {
        return { status: 'SUCCEEDED', executionId: execution.executionId, attempt: execution.attempt } as DispatchResult;
      }
      if (execution.status === 'FAILED') {
        throw new Error(`CONTRACT_VIOLATION: Cannot dispatch terminal FAILED execution "${executionId}". A new executionId must be created.`);
      }
      if (execution.status === 'UNKNOWN') {
        throw new Error(`CONTRACT_VIOLATION: Execution "${executionId}" is in UNKNOWN state. Explicit reconciliation is required before retry.`);
      }
      if (execution.status === 'DISPATCHING') {
        return { status: 'UNKNOWN', executionId: execution.executionId, errorCode: 'ALREADY_IN_PROGRESS', attempt: execution.attempt } as DispatchResult;
      }

      const ctx = this.contexts.get(contextId);
      if (!ctx) {
        throw new Error(`CONTRACT_VIOLATION: Context "${contextId}" not found`);
      }

      if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(ctx.status)) {
        throw new Error(`CONTRACT_VIOLATION: Context "${contextId}" is already in terminal status "${ctx.status}"`);
      }

      // Mark context as DISPATCHING under the queue lock
      ctx.status = 'DISPATCHING';
      ctx.version += 1;
      ctx.updatedAt = Date.now();

      let currentAttempt = execution.attempt;
      let lastResult: DispatchResult = { status: 'UNKNOWN', executionId, errorCode: 'INIT', attempt: currentAttempt };

      while (currentAttempt < this.retryPolicy.maxAttempts) {
        currentAttempt++;
        execution.attempt = currentAttempt;
        execution.status = 'DISPATCHING';
        execution.updatedAt = Date.now();

        if (!this.actionDispatcher) {
          execution.status = 'FAILED';
          execution.errorCode = 'DISPATCHER_NOT_CONFIGURED';
          execution.updatedAt = Date.now();
          ctx.status = 'WAITING_FOR_SLOT';
          ctx.version += 1;
          ctx.updatedAt = Date.now();
          return {
            status: 'FAILED',
            executionId: execution.executionId,
            errorCode: 'DISPATCHER_NOT_CONFIGURED',
            attempt: currentAttempt
          };
        }

        try {
          const result = await this.actionDispatcher(
            { type: execution.actionType, payload: execution.payload },
            {
              ...ctx,
              slots: { ...ctx.slots },
              missingSlots: [...ctx.missingSlots],
              offers: ctx.offers ? [...ctx.offers.map(o => ({ ...o }))] : undefined
            },
            execution
          );

          if (result.executionId !== execution.executionId || result.attempt !== execution.attempt) {
            execution.status = 'FAILED';
            execution.errorCode = 'DISPATCHER_IDENTITY_MISMATCH';
            ctx.status = 'WAITING_FOR_SLOT';
            ctx.version += 1;
            ctx.updatedAt = Date.now();
            throw new Error(`CONTRACT_VIOLATION: ActionDispatcher returned mismatched identity.`);
          }

          lastResult = result;
          execution.updatedAt = Date.now();

          if (result.status === 'SUCCEEDED') {
            execution.status = 'SUCCEEDED';
            ctx.status = 'COMPLETED';
            if (this.timerMap.has(contextId)) {
              clearTimeout(this.timerMap.get(contextId));
              this.timerMap.delete(contextId);
            }
            ctx.version += 1;
            ctx.updatedAt = Date.now();
            return result;
          }

          if (result.status === 'FAILED') {
            execution.errorCode = result.errorCode;
            if (!this.retryPolicy.retryableErrors.includes(result.errorCode)) {
              execution.status = 'FAILED';
              ctx.status = 'WAITING_FOR_SLOT';
              ctx.version += 1;
              ctx.updatedAt = Date.now();
              return result;
            }
          }

          if (result.status === 'UNKNOWN') {
            execution.status = 'UNKNOWN';
            execution.errorCode = result.errorCode;
            ctx.status = 'WAITING_FOR_SLOT';
            ctx.version += 1;
            ctx.updatedAt = Date.now();
            return result;
          }
        } catch (err: any) {
          if (err.message && err.message.startsWith('CONTRACT_VIOLATION')) {
            throw err;
          }
          const code = err.message || 'DISPATCH_ERROR';
          lastResult = { status: 'FAILED', executionId, errorCode: code, attempt: currentAttempt };
          execution.errorCode = code;

          if (!this.retryPolicy.retryableErrors.includes(code)) {
            execution.status = 'FAILED';
            ctx.status = 'WAITING_FOR_SLOT';
            ctx.version += 1;
            ctx.updatedAt = Date.now();
            return lastResult;
          }
        }
      }

      execution.status = lastResult.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
      if (execution.status === 'SUCCEEDED') {
        ctx.status = 'COMPLETED';
      } else {
        ctx.status = 'WAITING_FOR_SLOT';
        execution.errorCode = lastResult.errorCode || 'MAX_RETRIES_EXCEEDED';
      }
      ctx.version += 1;
      ctx.updatedAt = Date.now();
      return lastResult;
    }).finally(() => {
      if (this.contextMutationQueues.get(contextId) === dispatchPromise) {
        this.contextMutationQueues.delete(contextId);
      }
    });

    this.contextMutationQueues.set(contextId, dispatchPromise);
    return dispatchPromise.then(result => {
      const current = this.contexts.get(contextId);
      if (current && ['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(current.status) && this.activeContextId === contextId) {
        this.activeContextId = null;
      }
      return result;
    });
  }

  public async reconcileExecution(
    executionId: string,
    resolvedStatus: 'SUCCEEDED' | 'FAILED',
    identity: SessionIdentity,
    errorCode?: string
  ): Promise<ActionExecution> {
    this.validateIdentity(identity);
    const execution = this.executions.get(executionId);
    if (!execution) {
      throw new Error(`CONTRACT_VIOLATION: Execution "${executionId}" not found for reconciliation`);
    }

    if (execution.ownerId !== identity.ownerId || execution.sessionId !== identity.sessionId) {
      throw new Error('SECURITY_VIOLATION: Cross-session reconciliation is denied');
    }

    if (execution.status !== 'UNKNOWN') {
      throw new Error(`CONTRACT_VIOLATION: Cannot reconcile execution in non-UNKNOWN status (${execution.status})`);
    }

    execution.status = resolvedStatus;
    execution.updatedAt = Date.now();
    if (errorCode) execution.errorCode = errorCode;

    const ctx = this.contexts.get(execution.contextId);
    if (ctx) {
      await this.executeSerializedMutation(ctx.contextId, undefined, identity, async (c) => {
        c.status = resolvedStatus === 'SUCCEEDED' ? 'COMPLETED' : 'WAITING_FOR_SLOT';
        return { result: true };
      });
    }

    return execution;
  }

  public getExecution(executionId: string, identity: SessionIdentity): ActionExecution | undefined {
    this.validateIdentity(identity);
    const exec = this.executions.get(executionId);
    if (!exec) return undefined;
    if (exec.ownerId !== identity.ownerId || exec.sessionId !== identity.sessionId) {
      return undefined;
    }
    return { ...exec, payload: { ...exec.payload } };
  }

  public getExecutionLogs(identity: SessionIdentity): ActionExecution[] {
    this.validateIdentity(identity);
    return Array.from(this.executions.values())
      .filter(l => l.ownerId === identity.ownerId && l.sessionId === identity.sessionId)
      .map(l => ({
        ...l,
        payload: { ...l.payload },
        event: { type: l.actionType, payload: { ...l.payload } }
      }));
  }
}
