import { bootstrap } from "../apps/voice-demo/src/Bootstrap";
import { mountApp } from "../apps/voice-demo/src/App";
import type { ActionDispatcher } from "./platform/dialogue-manager";
import { platformExecutionBoundary, getAuthenticatedSessionIdentity } from "../apps/voice-demo/src/main";

export const rootProductionDispatcher: ActionDispatcher = async (event, ctx, exec) => {
  return platformExecutionBoundary.execute(event, exec);
};

if (import.meta.env.DEV && typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') &&
    (!(window as any).__AUTH_OWNER_ID__ || !(window as any).__AUTH_SESSION_ID__)) {
  // Local-only development identity; production still requires the host auth layer.
  (window as any).__AUTH_OWNER_ID__ = 'local-dev-owner';
  (window as any).__AUTH_SESSION_ID__ = 'local-dev-session';
}

const sessionIdentity = getAuthenticatedSessionIdentity();
const runtime = bootstrap(rootProductionDispatcher);
(runtime as any).platformExecutionBoundary = platformExecutionBoundary;
const root = document.querySelector<HTMLElement>("#app") || document.body;
mountApp(root, runtime, sessionIdentity);
