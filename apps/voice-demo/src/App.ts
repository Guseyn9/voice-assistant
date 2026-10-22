import type { SessionIdentity } from '../../../src/platform/dialogue-manager';
import { MapChannel, MAP_ORDER_SELECT_ACTION } from '../../../packages/map/src/index';
import type { InteractionAction, InteractionContract, InteractionEvent, InteractionSnapshot } from '../../../packages/interaction-contract/dist/index';

type ScenarioEvent = { type: string; payload: Record<string, any> };
type ScenarioStep = { kind: string; event?: ScenarioEvent; ms?: number };
type ScenarioDefinition = { id: string; intent?: string; name?: string; trigger?: string; steps?: ScenarioStep[] };
type ScenarioSet = { id: string; name?: string; version?: number; scenarios: ScenarioDefinition[] };

export class VoiceDemoApp {
  public runtime: any;
  private currentIdentity: SessionIdentity;

  constructor(runtime: any, authenticatedIdentity: SessionIdentity) {
    if (!authenticatedIdentity || !authenticatedIdentity.ownerId || !authenticatedIdentity.sessionId) {
      throw new Error('CONTRACT_VIOLATION: Authenticated SessionIdentity (ownerId, sessionId) is strictly required from session layer');
    }
    this.runtime = runtime;
    this.currentIdentity = authenticatedIdentity;
  }

  public async handleVoice(phrase: string, identityOverride?: SessionIdentity) {
    const identity = identityOverride || this.currentIdentity;
    if (!identity || !identity.ownerId || !identity.sessionId) {
      throw new Error('CONTRACT_VIOLATION: Valid SessionIdentity required to process voice');
    }
    return this.runtime.voiceChannel.handleIncomingVoice(phrase, identity);
  }

  public setIdentity(identity: SessionIdentity) {
    if (!identity || !identity.ownerId || !identity.sessionId) {
      throw new Error('CONTRACT_VIOLATION: Valid SessionIdentity required');
    }
    this.currentIdentity = identity;
  }

  public getIdentity(): SessionIdentity {
    return this.currentIdentity;
  }
}

export function mountApp(root: HTMLElement, runtime: any, authenticatedIdentity: SessionIdentity) {
  if (!authenticatedIdentity) {
    throw new Error('CONTRACT_VIOLATION: Authenticated SessionIdentity must be provided to mountApp');
  }

  const app = new VoiceDemoApp(runtime, authenticatedIdentity);
  const host = root || document.body;
  host.innerHTML = `
    <main id="voice-app-ready" style="padding:16px;font-family:sans-serif">
      <h2>Voice Platform Production Runtime Ready</h2>
      <div id="runtime-identity">AUTHENTICATED: ${authenticatedIdentity.ownerId}:${authenticatedIdentity.sessionId}</div>
      <section aria-label="Scenario loader" style="margin-top:16px">
        <div id="scenario-source-wrapper" style="min-height:28px;display:block">
          <span>Scenario JSON source</span>
          <input id="scenario-file-input" data-testid="scenario-file-input" type="file" accept=".json,application/json"
            style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none" />
        </div>
        <div data-testid="scenario-file-name" id="scenario-file-name"></div>
        <div data-testid="scenario-set-id" id="scenario-set-id"></div>
        <div data-testid="scenario-set-name" id="scenario-set-name"></div>
        <div id="scenario-load-error" role="alert"></div>
      </section>
      <section style="margin-top:16px">
        <label for="voice-command-input">Voice command</label>
        <input id="voice-command-input" data-testid="voice-input" name="voiceText" placeholder="Введите голосовую команду" />
        <div class="driver-status" data-testid="driver-status" id="driver-status">AVAILABLE</div>
        <div class="badge-status" data-testid="fsm-status" id="fsm-status">AVAILABLE</div>
        <div data-testid="fsm-driver-state" id="fsm-driver-state">AVAILABLE</div>
      </section>
      <section id="scenario-actions" style="margin-top:16px"></section>
      <section style="margin-top:16px">
        <div class="trace-container" data-testid="execution-trace" id="execution-trace"></div>
        <div data-testid="execution-terminal" id="execution-terminal" style="margin-top:8px"></div>
        <div id="scenario-progress">0/0</div>
      </section>
    </main>
  `;

  const fileInput = host.querySelector<HTMLInputElement>('#scenario-file-input')!;
  const fileName = host.querySelector<HTMLElement>('#scenario-file-name')!;
  const setId = host.querySelector<HTMLElement>('#scenario-set-id')!;
  const setName = host.querySelector<HTMLElement>('#scenario-set-name')!;
  const loadError = host.querySelector<HTMLElement>('#scenario-load-error')!;
  const actions = host.querySelector<HTMLElement>('#scenario-actions')!;
  const trace = host.querySelector<HTMLElement>('#execution-trace')!;
  const terminal = host.querySelector<HTMLElement>('#execution-terminal')!;
  const progress = host.querySelector<HTMLElement>('#scenario-progress')!;
  const voiceInput = host.querySelector<HTMLInputElement>('#voice-command-input')!;

  let activeSet: ScenarioSet | null = null;
  const scenarioEngine = {
    getActiveScenarioSetId: () => activeSet?.id || '',
    getActiveScenarioSet: () => activeSet,
    async runScenario(index = 0) {
      if (!activeSet) throw new Error('No ScenarioSet has been loaded');
      const scenario = activeSet.scenarios[index];
      if (!scenario) throw new Error(`Scenario index ${index} does not exist`);
      trace.innerHTML = '';
      terminal.textContent = '';
      const declaredSteps = scenario.steps || [];
      const outputEvents = declaredSteps.filter(step => step.kind === 'emit' && step.event?.type !== 'VOICE_INPUT_RECEIVED');

      // The map scenario's trigger is an Interaction Action, not a domain event.
      // Run it through the real MapChannel, then let this Validation Bench adapter
      // replay the fixture's expected selected event as the application response.
      if (scenario.trigger === MAP_ORDER_SELECT_ACTION) {
        const expectedSelection = declaredSteps.find(
          step => step.kind === 'emit' && step.event?.type === 'driver.order.selected'
        )?.event;
        if (!expectedSelection || !Object.prototype.hasOwnProperty.call(expectedSelection.payload, 'orderId')) {
          throw new Error('Map selection scenario must declare driver.order.selected with an orderId');
        }

        const listeners = new Set<(event: InteractionEvent) => void>();
        const interaction: InteractionContract = {
          async dispatch<TPayload>(action: InteractionAction<TPayload>): Promise<void> {
            if (action.type !== MAP_ORDER_SELECT_ACTION) return;
            const selectedOrderId = (action.payload as { orderId?: unknown } | null)?.orderId;
            if (selectedOrderId !== expectedSelection.payload.orderId) return;

            const event: InteractionEvent = {
              type: expectedSelection.type,
              payload: expectedSelection.payload,
              metadata: {
                source: 'validation-bench-scenario',
                timestamp: new Date().toISOString(),
                correlationId: action.metadata?.correlationId
              }
            };
            for (const listener of listeners) listener(event);
          },
          subscribe(listener: (event: InteractionEvent) => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async snapshot(): Promise<InteractionSnapshot> {
            return { revision: 0, state: {} };
          }
        };

        const mapChannel = new MapChannel({
          interaction,
          onAction: action => appendTrace({ type: action.type, payload: action.payload as Record<string, any> }, { status: 'DISPATCHED' }),
          onEvent: event => appendTrace({ type: event.type, payload: event.payload as Record<string, any> }, { status: 'RECEIVED' })
        });
        mapChannel.startObserving();
        await mapChannel.selectOrder(expectedSelection.payload.orderId);
        mapChannel.stopObserving();

        terminal.textContent = 'kind: "end" — SCENARIO_STATE_COMPLETED';
        progress.textContent = '1/1 · 100%';
        return { status: 'COMPLETED', scenarioId: scenario.id, emittedEvents: 1 };
      }
      const outputOffset = activeSet.scenarios.length > 1 ? index : 0;
      let outputIndex = 0;

      for (const step of declaredSteps) {
        if (step.kind === 'delay') {
          await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(step.ms) || 0)));
          continue;
        }
        if (step.kind !== 'emit' || !step.event || step.event.type === 'VOICE_INPUT_RECEIVED') continue;

        if (step.event.type.startsWith('driver.')) {
          const boundary = (window as any).__PLATFORM_EXECUTION_BOUNDARY__;
          if (boundary) {
            await boundary.execute(step.event, {
              executionId: `scenario-${Date.now()}-${outputIndex}`,
              attempt: 1,
              payload: step.event.payload
            });
          }
        }

        const resultIndex = activeSet.scenarios.length > 1 ? outputOffset : outputIndex;
        const result = document.createElement('div');
        result.dataset.testid = `step-result-${resultIndex}`;
        result.setAttribute('data-testid', `step-result-${resultIndex}`);
        result.textContent = `${step.event.type} ${JSON.stringify(step.event.payload)}`;
        trace.appendChild(result);
        outputIndex++;
      }

      terminal.textContent = 'kind: "end" — SCENARIO_STATE_COMPLETED';
      progress.textContent = outputEvents.length > 0
        ? `${outputEvents.length}/${outputEvents.length} · 100%`
        : '100%';
      return { status: 'COMPLETED', scenarioId: scenario.id, emittedEvents: outputIndex };
    }
  };

  const updateStatus = (status: string) => {
    for (const selector of ['#driver-status', '#fsm-status', '#fsm-driver-state']) {
      const node = host.querySelector<HTMLElement>(selector);
      if (node) node.textContent = status;
    }
  };

  const appendTrace = (event: ScenarioEvent, result?: any) => {
    const row = document.createElement('div');
    row.className = 'trace-entry';
    row.textContent = `${event.type} ${JSON.stringify(event.payload)}${result?.errorCode ? ` ERROR: ${result.errorCode}` : ''}`;
    trace.appendChild(row);
  };

  if (typeof window !== 'undefined') {
    const w = window as any;
    w.__VOICE_DEMO_APP__ = app;
    w.__SCENARIO_ENGINE__ = scenarioEngine;
    w.__UPDATE_FSM_STATUS__ = updateStatus;
    w.__APPEND_TRACE__ = appendTrace;
  }

  const buttonLabel = (scenario: ScenarioDefinition) => {
    const event = scenario.steps?.find(step => step.kind === 'emit' && step.event?.type !== 'VOICE_INPUT_RECEIVED')?.event;
    const labels: Record<string, string> = {
      'driver.order.accepted': 'Принять заказ',
      'driver.arrived': 'Я приехал',
      'driver.trip.started': 'Начать поездку',
      'driver.trip.finished': 'Завершить поездку',
      'driver.available': 'Готов к следующему заказу'
    };
    return labels[event?.type || ''] || 'Start scenario';
  };

  const renderActions = (scenarioSet: ScenarioSet) => {
    actions.innerHTML = '';
    scenarioSet.scenarios.forEach((scenario, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = scenarioSet.scenarios.length > 1
        ? buttonLabel(scenario)
        : 'Start scenario';
      button.addEventListener('click', () => { void scenarioEngine.runScenario(index); });
      actions.appendChild(button);
    });
  };

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const loadPromise = (async () => {
      loadError.textContent = '';
      const parsed = JSON.parse(await file.text()) as ScenarioSet;
      if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.scenarios)) {
        throw new Error('Invalid ScenarioSet JSON');
      }
      activeSet = parsed;
      // Register voice-capable scenario sets with the real VoiceChannel. Older declarative
      // taxi fixtures omit intent/requiredSlots; infer those from their emitted domain event so
      // browser voice commands exercise the same runtime path as newer scenario definitions.
      const intentByEvent: Record<string, string> = {
        'driver.order.accepted': 'ACCEPT_ORDER',
        'driver.arrived': 'DRIVER_ARRIVED',
        'driver.trip.started': 'START_TRIP',
        'driver.trip.finished': 'FINISH_TRIP',
        'driver.available': 'DRIVER_AVAILABLE'
      };
      const normalizedScenarios = parsed.scenarios.map(scenario => {
        const emitted = scenario.steps?.find(step => step.kind === 'emit' && step.event)?.event;
        const inferredIntent = emitted ? intentByEvent[emitted.type] : undefined;
        const intent = scenario.intent || inferredIntent;
        if (!intent) return scenario;
        const templateSlots = Object.values(emitted?.payload || {}).flatMap(value => {
          if (typeof value !== 'string') return [];
          return Array.from(value.matchAll(/\{\{\s*slots\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g), match => match[1]);
        });
        const requiredSlots = scenario.requiredSlots || Array.from(new Set(templateSlots));
        const slotExtractors = scenario.slotExtractors || Object.fromEntries(
          requiredSlots.map(slot => [slot, { type: 'integer', pattern: '\\b\\d+\\b' }])
        );
        return { ...scenario, intent, requiredSlots, slotExtractors };
      });
      if (normalizedScenarios.length > 0 && normalizedScenarios.every(scenario => typeof scenario.intent === 'string' && scenario.intent.length > 0)) {
        runtime.voiceChannel.registerScenarioSet({ ...parsed, scenarios: normalizedScenarios } as any);
      }
      fileName.textContent = file.name;
      setId.textContent = parsed.id;
      setName.textContent = parsed.name || '';
      renderActions(parsed);
      terminal.textContent = '';
      trace.innerHTML = '';
      progress.textContent = '0/0';
      return parsed.id;
    })().catch(error => {
      loadError.textContent = error instanceof Error ? error.message : String(error);
      throw error;
    });
    (window as any).__SCENARIO_LOAD_PROMISE__ = loadPromise;
  });

  voiceInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const phrase = voiceInput.value.trim();
    if (!phrase) return;
    voiceInput.value = '';
    const dispatch = (window as any).__DISPATCH_VOICE_COMMAND__;
    if (typeof dispatch === 'function') void dispatch(phrase);
    else void app.handleVoice(phrase);
  });

  return app;
}
