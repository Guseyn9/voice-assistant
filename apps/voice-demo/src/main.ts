import { bootstrap } from "./Bootstrap";
import { mountApp } from "./App";
import type { ActionDispatcher, SessionIdentity } from "../../../src/platform/dialogue-manager";

// Strict Authenticated Session Provider (Zero fallback)
export function getAuthenticatedSessionIdentity(): SessionIdentity {
  const ownerId = typeof window !== 'undefined' ? (window as any).__AUTH_OWNER_ID__ : undefined;
  const sessionId = typeof window !== 'undefined' ? (window as any).__AUTH_SESSION_ID__ : undefined;

  if (!ownerId || !sessionId || typeof ownerId !== 'string' || typeof sessionId !== 'string') {
    throw new Error('CONTRACT_VIOLATION: No authenticated session found. SessionIdentity must be established prior to application startup.');
  }

  return { ownerId, sessionId };
}

// Runtime boundary for the driver's order lifecycle.
export class PlatformFsmExecutionBoundary {
  private activeOrders: Map<number, { status: string; executionId: string; updatedAt: number }> = new Map();
  private currentOrderId: number | null = null;
  private driverStatus = 'AVAILABLE';

  private publishStatus(status: string) {
    this.driverStatus = status;
    if (typeof window !== 'undefined') {
      (window as any).__UPDATE_FSM_STATUS__?.(status);
    }
  }

  private publishEvent(event: { type: string; payload: Record<string, any> }, result?: any) {
    if (typeof window !== 'undefined') {
      (window as any).__APPEND_TRACE__?.(event, result);
    }
  }

  public async execute(event: { type: string; payload: Record<string, any> }, exec: any) {
    if (!event || typeof event !== 'object' || !event.type || typeof event.type !== 'string') {
      return { status: 'FAILED' as const, executionId: exec.executionId, errorCode: 'INVALID_EVENT_FORMAT', attempt: exec.attempt };
    }
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      return { status: 'FAILED' as const, executionId: exec.executionId, errorCode: 'INVALID_PAYLOAD_STRUCTURE', attempt: exec.attempt };
    }
    if (JSON.stringify(event.payload) !== JSON.stringify(exec.payload)) {
      return { status: 'FAILED' as const, executionId: exec.executionId, errorCode: 'PAYLOAD_MUTATION_DETECTED', attempt: exec.attempt };
    }

    // Preserve the generic order-dispatch contract used by existing callers.
    if (event.type === 'order.accepted' || event.type === 'order.dispatch.completed') {
      const orderId = Number(event.payload.orderId);
      if (!Number.isFinite(orderId) || orderId <= 0) {
        return { status: 'FAILED' as const, executionId: exec.executionId, errorCode: 'INVALID_ORDER_ID', attempt: exec.attempt };
      }
      this.activeOrders.set(orderId, { status: 'DISPATCHED', executionId: exec.executionId, updatedAt: Date.now() });
      this.currentOrderId = orderId;
      this.publishStatus('DISPATCHED');
      this.publishEvent(event);
      return { status: 'SUCCEEDED' as const, executionId: exec.executionId, attempt: exec.attempt };
    }

    const orderIdFromPayload = event.payload.orderId === undefined ? undefined : Number(event.payload.orderId);
    const orderId = Number.isFinite(orderIdFromPayload) && Number(orderIdFromPayload) > 0
      ? Number(orderIdFromPayload)
      : this.currentOrderId;
    const currentStatus = orderId ? (this.activeOrders.get(orderId)?.status || this.driverStatus) : this.driverStatus;

    const transitions: Record<string, { from: string[]; to: string; requiresOrder: boolean }> = {
      'driver.order.accepted': { from: ['AVAILABLE', 'TRIP_FINISHED', 'DISPATCHED'], to: 'ORDER_ACCEPTED', requiresOrder: true },
      'driver.arrived': { from: ['ORDER_ACCEPTED'], to: 'DRIVER_ARRIVED', requiresOrder: true },
      'driver.trip.started': { from: ['DRIVER_ARRIVED'], to: 'IN_TRIP', requiresOrder: true },
      'driver.trip.finished': { from: ['IN_TRIP'], to: 'TRIP_FINISHED', requiresOrder: true },
      'driver.available': { from: ['TRIP_FINISHED'], to: 'AVAILABLE', requiresOrder: false }
    };
    const transition = transitions[event.type];
    if (!transition) {
      return {
        status: 'FAILED' as const,
        executionId: exec.executionId,
        errorCode: `UNKNOWN_ACTION_TYPE_${event.type}`,
        attempt: exec.attempt
      };
    }
    if (transition.requiresOrder && (!orderId || !Number.isFinite(orderId) || orderId <= 0)) {
      return { status: 'FAILED' as const, executionId: exec.executionId, errorCode: 'INVALID_ORDER_ID', attempt: exec.attempt };
    }
    if (!transition.from.includes(currentStatus)) {
      return {
        status: 'FAILED' as const,
        executionId: exec.executionId,
        errorCode: 'INVALID_FSM_TRANSITION',
        message: `Cannot transition from ${currentStatus} via ${event.type}`,
        attempt: exec.attempt
      };
    }

    if (orderId) {
      this.activeOrders.set(orderId, { status: transition.to, executionId: exec.executionId, updatedAt: Date.now() });
      this.currentOrderId = orderId;
    }
    this.publishStatus(transition.to);
    this.publishEvent(event);
    return { status: 'SUCCEEDED' as const, executionId: exec.executionId, attempt: exec.attempt };
  }

  public getOrderState(orderId: number) {
    return this.activeOrders.get(orderId);
  }

  public getDriverStatus() {
    return this.driverStatus;
  }
}

export const platformExecutionBoundary = new PlatformFsmExecutionBoundary();

export const productionActionDispatcher: ActionDispatcher = async (event, ctx, exec) => {
  return platformExecutionBoundary.execute(event, exec);
};

// Application startup is owned by the root src/main.ts entrypoint.
// Keep this module side-effect-free because its exports are imported by src/main.ts.
