import { bootstrap } from "./Bootstrap";
import { mountApp } from "./App";
import { ActionDispatcher, SessionIdentity } from "../../../src/platform/dialogue-manager";

// Strict Authenticated Session Provider (Zero fallback)
export function getAuthenticatedSessionIdentity(): SessionIdentity {
  const ownerId = typeof window !== 'undefined' ? (window as any).__AUTH_OWNER_ID__ : undefined;
  const sessionId = typeof window !== 'undefined' ? (window as any).__AUTH_SESSION_ID__ : undefined;

  if (!ownerId || !sessionId || typeof ownerId !== 'string' || typeof sessionId !== 'string') {
    throw new Error('CONTRACT_VIOLATION: No authenticated session found. SessionIdentity must be established prior to application startup.');
  }

  return { ownerId, sessionId };
}

// Real FSM / State Execution Engine Boundary
export class PlatformFsmExecutionBoundary {
  private activeOrders: Map<number, { status: string; executionId: string; updatedAt: number }> = new Map();

  public async execute(event: { type: string; payload: Record<string, any> }, exec: any) {
    // 1. Strict Payload Validation
    if (!event || typeof event !== 'object' || !event.type || typeof event.type !== 'string') {
      return {
        status: 'FAILED' as const,
        executionId: exec.executionId,
        errorCode: 'INVALID_EVENT_FORMAT',
        attempt: exec.attempt
      };
    }

    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      return {
        status: 'FAILED' as const,
        executionId: exec.executionId,
        errorCode: 'INVALID_PAYLOAD_STRUCTURE',
        attempt: exec.attempt
      };
    }

    // Invariant: Event payload must match execution payload immutably
    if (JSON.stringify(event.payload) !== JSON.stringify(exec.payload)) {
      return {
        status: 'FAILED' as const,
        executionId: exec.executionId,
        errorCode: 'PAYLOAD_MUTATION_DETECTED',
        attempt: exec.attempt
      };
    }

    // 2. Business Logic Execution via FSM
    if (event.type === 'order.accepted' || event.type === 'order.dispatch.completed') {
      const orderId = Number(event.payload.orderId);
      if (!Number.isFinite(orderId) || orderId <= 0) {
        return {
          status: 'FAILED' as const,
          executionId: exec.executionId,
          errorCode: 'INVALID_ORDER_ID',
          attempt: exec.attempt
        };
      }

      // Transition order state in FSM
      this.activeOrders.set(orderId, {
        status: 'DISPATCHED',
        executionId: exec.executionId,
        updatedAt: Date.now()
      });

      return {
        status: 'SUCCEEDED' as const,
        executionId: exec.executionId,
        attempt: exec.attempt
      };
    }

    return {
      status: 'FAILED' as const,
      executionId: exec.executionId,
      errorCode: `UNKNOWN_ACTION_TYPE_${event.type}`,
      attempt: exec.attempt
    };
  }

  public getOrderState(orderId: number) {
    return this.activeOrders.get(orderId);
  }
}

export const platformExecutionBoundary = new PlatformFsmExecutionBoundary();

export const productionActionDispatcher: ActionDispatcher = async (event, ctx, exec) => {
  return platformExecutionBoundary.execute(event, exec);
};

// Start application with resolved authenticated session
const sessionIdentity = getAuthenticatedSessionIdentity();
const runtime = bootstrap(productionActionDispatcher);
const root = document.querySelector<HTMLElement>("#app") || document.body;
mountApp(root, runtime, sessionIdentity);
