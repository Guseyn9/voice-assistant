import { bootstrap } from '../apps/voice-demo/src/Bootstrap';
import { mountApp } from '../apps/voice-demo/src/App';
import { productionActionDispatcher, platformExecutionBoundary } from '../apps/voice-demo/src/main';

export function mountPlatformRuntime() {
  const root = document.getElementById('root');
  if (!root) throw new Error('Platform runtime root element #root is missing');
  const runtime = bootstrap(productionActionDispatcher);
  const w = window as any;
  w.__PLATFORM_EXECUTION_BOUNDARY__ = platformExecutionBoundary;
  const identity = {
    ownerId: w.__AUTH_OWNER_ID__ || 'local-platform-demo',
    sessionId: w.__AUTH_SESSION_ID__ || 'local-platform-session'
  };
  const app = mountApp(root, runtime, identity);
  w.__DISPATCH_VOICE_COMMAND__ = (phrase: string) => app.handleVoice(phrase, identity);
  return app;
}
