import { DialogueStateManager } from './dialogue-manager';
import type {
  ActionDispatcher,
  SessionIdentity,
  OfferDefinition,
  DialogueContext,
  RoutingResult
} from './dialogue-manager';

export interface SlotRule {
  pattern: string;
  value: any;
}

export interface SlotExtractorDefinition {
  type: 'integer' | 'enum' | 'string';
  pattern?: string;
  values?: string[];
  patterns?: string[];
  rules?: SlotRule[];
  mapping?: Record<string, string[]>;
  priority?: number;
}

export interface ScenarioStep {
  kind: 'emit' | 'end';
  event?: {
    type: string;
    payload: Record<string, any>;
  };
}

export interface ScenarioQueryEvaluation {
  kind: 'compare' | 'query_attribute';
  attribute?: string;
  order?: 'min' | 'max';
  targetIndex?: number;
  responseTemplate?: string;
}

export interface CandidateBindingDefinition {
  targetSlot?: string;
  idField?: string;
  labelField?: string;
  indexField?: string;
  statusField?: string;
  unavailableValue?: string;
  unavailableTemplate?: string;
  ambiguityTriggerValues?: string[];
}

export interface ConfirmationDefinition {
  slot: string;
  confirmedValue: string;
  rejectedValue: string;
  confirmLabel?: string;
  rejectLabel?: string;
  confirmedMessage?: string;
  cancelledMessage?: string;
}

export interface ScenarioDefinition {
  id: string;
  name?: string;
  activation?: {
    type: 'voice';
    value: string;
  };
  triggerPhrases?: string[];
  expectedPhrase?: string;
  aliases?: string[];
  priority?: number;
  intent: string;
  requiredSlots?: string[];
  slotExtractors?: Record<string, SlotExtractorDefinition>;
  candidateBinding?: CandidateBindingDefinition;
  confirmation?: ConfirmationDefinition;
  clarificationPrompts?: Record<string, string>;
  ambiguityPrompt?: {
    template: string;
  };
  evaluation?: ScenarioQueryEvaluation;
  query?: {
    attribute: string;
    mode: 'min' | 'max';
  };
  responseTemplate?: string;
  steps?: ScenarioStep[];
}

export interface ScenarioSet {
  version: number;
  id: string;
  name?: string;
  description?: string;
  scenarios: ScenarioDefinition[];
}

export type CandidateItem = Record<string, unknown>;

export type CandidateResolutionResult =
  | { status: 'RESOLVED'; targetId: string; targetItem: CandidateItem }
  | { status: 'CANDIDATE_UNAVAILABLE'; targetId: string; targetItem: CandidateItem; message: string }
  | { status: 'AMBIGUOUS_SLOT'; candidates: Array<{ slotName: string; value: any; scenarioId: string }>; clarificationPrompt?: string }
  | { status: 'NO_MATCH' };

export type IntentResolutionResult =
  | { status: 'RESOLVED'; scenarioId: string; intent: string; scenario: ScenarioDefinition }
  | { status: 'AMBIGUOUS_INTENT'; candidateScenarioIds: string[]; candidateIntents: string[]; clarificationPrompt?: string }
  | { status: 'NO_MATCH' };

export type SlotExtractionResult =
  | { status: 'RESOLVED'; slots: Record<string, any> }
  | { status: 'AMBIGUOUS_SLOT'; candidates: Array<{ slotName: string; value: any; scenarioId: string }>; clarificationPrompt?: string }
  | { status: 'NO_MATCH' };

export class VoiceChannel {
  private dialogueManager: DialogueStateManager;
  private scenarioRegistry: ScenarioDefinition[] = [];
  private activeScenarioSetId: string = '';
  private activeScenarioIds: Set<string> = new Set();
  private explicitContextSelections: Map<string, string> = new Map();

  constructor(dialogueManager: DialogueStateManager) {
    this.dialogueManager = dialogueManager;
  }

  public registerScenarioSet(scenarioSet: ScenarioSet): void {
    if (!scenarioSet || !Array.isArray(scenarioSet.scenarios)) {
      throw new Error('CONTRACT_VIOLATION: Invalid ScenarioSet structure');
    }
    if (typeof scenarioSet.id !== 'string' || !scenarioSet.id.trim()) {
      throw new Error('CONTRACT_VIOLATION: ScenarioSet missing valid id');
    }

    const seenIds = new Set<string>();
    const triggerOwners = new Map<string, Array<{ id: string; priority: number }>>();

    const normalizeTrigger = (value: string): string =>
      value.replace(/^voice\./i, '').replace(/[-_]/g, ' ').toLowerCase().trim().replace(/\s+/g, ' ');

    for (const sc of scenarioSet.scenarios) {
      if (!sc.id || typeof sc.id !== 'string') {
        throw new Error('CONTRACT_VIOLATION: Scenario missing valid id');
      }
      if (seenIds.has(sc.id)) {
        throw new Error(`CONTRACT_VIOLATION: Duplicate scenario id "${sc.id}"`);
      }
      seenIds.add(sc.id);

      if (!sc.intent || typeof sc.intent !== 'string') {
        throw new Error(`CONTRACT_VIOLATION: Scenario "${sc.id}" missing intent`);
      }
      if (sc.priority !== undefined && !Number.isFinite(sc.priority)) {
        throw new Error(`CONTRACT_VIOLATION: Scenario "${sc.id}" has invalid priority; priority must be a finite number`);
      }

      const triggers = [
        sc.activation?.value,
        sc.expectedPhrase,
        ...(Array.isArray(sc.triggerPhrases) ? sc.triggerPhrases : []),
        ...(Array.isArray(sc.aliases) ? sc.aliases : [])
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

      for (const trigger of triggers) {
        const normalized = normalizeTrigger(trigger);
        const owners = triggerOwners.get(normalized) || [];
        const priority = sc.priority ?? 0;
        const conflictingOwner = owners.find(owner => owner.id !== sc.id && owner.priority === priority);
        if (conflictingOwner) {
          throw new Error(`CONTRACT_VIOLATION: Trigger or alias collision "${normalized}" between scenarios "${conflictingOwner.id}" and "${sc.id}"`);
        }
        if (!owners.some(owner => owner.id === sc.id)) {
          owners.push({ id: sc.id, priority });
        }
        triggerOwners.set(normalized, owners);
      }
    }

    // Validate the entire set before mutating the active registry. A bad replacement
    // must leave the previous, working set available.
    const nextRegistry = [...this.scenarioRegistry];
    for (const sc of scenarioSet.scenarios) {
      const registeredScenario = {
        ...sc,
        triggerPhrases: sc.triggerPhrases ? [...sc.triggerPhrases] : undefined,
        aliases: sc.aliases ? [...sc.aliases] : undefined
      };
      const existingIndex = nextRegistry.findIndex(existing => existing.id === sc.id);
      if (existingIndex >= 0) {
        nextRegistry[existingIndex] = registeredScenario;
      } else {
        nextRegistry.push(registeredScenario);
      }
    }
    this.scenarioRegistry = nextRegistry;
    this.activeScenarioIds = new Set(scenarioSet.scenarios.map(sc => sc.id));
    this.activeScenarioSetId = scenarioSet.id;
  }

  public getActiveScenarioSetId(): string {
    return this.activeScenarioSetId;
  }

  public setActionDispatcher(dispatcher: ActionDispatcher): void {
    this.dialogueManager.setActionDispatcher(dispatcher);
  }

  public getDeterministicScenarioForIntent(intent: string): ScenarioDefinition | undefined {
    const matching = this.scenarioRegistry.filter(sc => sc.intent === intent);
    if (matching.length === 0) return undefined;
    if (matching.length === 1) return matching[0];

    const maxPriority = Math.max(...matching.map(s => s.priority ?? 0));
    const highest = matching.filter(s => (s.priority ?? 0) === maxPriority);
    highest.sort((a, b) => a.id.localeCompare(b.id));
    return highest[0];
  }

  public resolveIntent(phrase: string): IntentResolutionResult {
    const text = phrase.trim().toLowerCase();
    const matchingScenarios: ScenarioDefinition[] = [];
    const fullyMatchedScenarioIds = new Set<string>();

    for (const sc of this.scenarioRegistry.filter(scenario => this.activeScenarioIds.has(scenario.id))) {
      const triggers: string[] = [];
      if (sc.activation?.value) triggers.push(sc.activation.value);
      if (sc.expectedPhrase) triggers.push(sc.expectedPhrase);
      if (Array.isArray(sc.triggerPhrases)) triggers.push(...sc.triggerPhrases);
      if (Array.isArray(sc.aliases)) triggers.push(...sc.aliases);

      const matches = triggers.some(trig => {
        const clean = trig.replace(/^voice\./, '').replace(/[-_]/g, ' ').toLowerCase().trim();
        // A user may provide only the leading part of a multi-word trigger. Keep it
        // as a candidate for ambiguity, but do not let a partially matched information
        // query steal an exact selection phrase such as "второй".
        const fullMatch = text === clean ||
          text.startsWith(clean) ||
          clean.split(/\s+/).every(w => text.includes(w));
        if (fullMatch) fullyMatchedScenarioIds.add(sc.id);
        return fullMatch || clean.startsWith(`${text} `);
      });

      if (matches) {
        matchingScenarios.push(sc);
      }
    }

    if (matchingScenarios.length === 0) {
      return { status: 'NO_MATCH' };
    }

    if (matchingScenarios.length === 1) {
      const sc = matchingScenarios[0];
      return { status: 'RESOLVED', scenarioId: sc.id, intent: sc.intent, scenario: sc };
    }

    const maxPriority = Math.max(...matchingScenarios.map(s => s.priority ?? 0));
    const highestCandidates = matchingScenarios.filter(s => (s.priority ?? 0) === maxPriority);

    const infoCandidate = highestCandidates.find(s => s.evaluation?.kind === 'query_attribute' && fullyMatchedScenarioIds.has(s.id));
    if (infoCandidate) {
      return { status: 'RESOLVED', scenarioId: infoCandidate.id, intent: infoCandidate.intent, scenario: infoCandidate };
    }

    if (highestCandidates.length === 1) {
      const sc = highestCandidates[0];
      return { status: 'RESOLVED', scenarioId: sc.id, intent: sc.intent, scenario: sc };
    }

    return {
      status: 'AMBIGUOUS_INTENT',
      candidateScenarioIds: highestCandidates.map(s => s.id),
      candidateIntents: highestCandidates.map(s => s.intent),
      clarificationPrompt: highestCandidates[0].ambiguityPrompt?.template
    };
  }

  public extractSlotsDeterministically(
    text: string,
    extractors?: Record<string, SlotExtractorDefinition>,
    scenarioId: string = 'sc',
    ambiguityPromptTemplate?: string
  ): SlotExtractionResult {
    if (!extractors || Object.keys(extractors).length === 0) {
      return { status: 'RESOLVED', slots: {} };
    }

    type MatchCandidate = {
      slotName: string;
      value: any;
      matchedText: string;
      priority: number;
    };
    const candidates: MatchCandidate[] = [];

    const addCandidate = (slotName: string, value: any, matchedText: string, priority: number) => {
      if (!matchedText) return;
      candidates.push({ slotName, value, matchedText: matchedText.toLocaleLowerCase(), priority });
    };

    for (const [slotName, extractor] of Object.entries(extractors)) {
      const priority = Number.isFinite(extractor.priority) ? Number(extractor.priority) : 0;

      if (Array.isArray(extractor.rules)) {
        for (const rule of extractor.rules) {
          // JavaScript's \\b is ASCII-only for Cyrillic. Translate paired boundaries
          // to Unicode letter/digit lookarounds without changing the declarative JSON.
          let boundaryIndex = 0;
          const unicodePattern = rule.pattern.replace(/\\b/g, () => {
            const isLeftBoundary = boundaryIndex++ % 2 === 0;
            return isLeftBoundary
              ? '(?<![\\p{L}\\p{N}_])'
              : '(?![\\p{L}\\p{N}_])';
          });
          const match = new RegExp(unicodePattern, 'iu').exec(text);
          if (match) {
            addCandidate(slotName, rule.value, match[0], priority);
          }
        }
      } else if (extractor.type === 'enum') {
        if (Array.isArray(extractor.patterns)) {
          for (const pattern of extractor.patterns) {
            const match = new RegExp(pattern, 'iu').exec(text);
            if (match) addCandidate(slotName, 'CONFIRMED', match[0], priority);
          }
        } else if (extractor.mapping) {
          for (const [enumValue, synonyms] of Object.entries(extractor.mapping)) {
            const matchedSynonyms = synonyms
              .filter(synonym => text.toLocaleLowerCase().includes(synonym.toLocaleLowerCase()))
              .sort((a, b) => b.length - a.length);
            // Keep the most specific synonym for each enum value. If different values
            // share the same best phrase (e.g. "терминал"), the ambiguity is preserved.
            if (matchedSynonyms.length > 0) {
              addCandidate(slotName, enumValue, matchedSynonyms[0], priority);
            }
          }
        }
      } else if (extractor.pattern) {
        const match = new RegExp(extractor.pattern, 'iu').exec(text);
        if (match) {
          const value = extractor.type === 'integer' ? Number.parseInt(match[0], 10) : match[0];
          if (extractor.type !== 'integer' || Number.isFinite(value)) {
            addCandidate(slotName, value, match[0], priority);
          }
        }
      } else if (extractor.type === 'string') {
        const value = text.trim();
        if (value) addCandidate(slotName, value, value, priority);
      }
    }

    if (candidates.length === 0) {
      return { status: 'NO_MATCH' };
    }

    // First resolve competition inside each slot. The most specific matching phrase
    // wins; equally specific, equally prioritized different values are ambiguous.
    const bySlot = new Map<string, MatchCandidate[]>();
    for (const candidate of candidates) {
      const group = bySlot.get(candidate.slotName) || [];
      group.push(candidate);
      bySlot.set(candidate.slotName, group);
    }

    const slotWinners: MatchCandidate[] = [];
    for (const group of bySlot.values()) {
      const maxPriority = Math.max(...group.map(candidate => candidate.priority));
      const priorityWinners = group.filter(candidate => candidate.priority === maxPriority);
      const maxSpecificity = Math.max(...priorityWinners.map(candidate => candidate.matchedText.length));
      const specificWinners = priorityWinners.filter(candidate => candidate.matchedText.length === maxSpecificity);
      const distinctValues = new Map<string, MatchCandidate>();
      for (const candidate of specificWinners) {
        const key = JSON.stringify(candidate.value);
        if (!distinctValues.has(key)) distinctValues.set(key, candidate);
      }

      if (distinctValues.size > 1) {
        return {
          status: 'AMBIGUOUS_SLOT',
          candidates: [...distinctValues.values()]
            .sort((a, b) => String(a.value).localeCompare(String(b.value)))
            .map(candidate => ({ slotName: candidate.slotName, value: candidate.value, scenarioId })),
          clarificationPrompt: ambiguityPromptTemplate
        };
      }
      slotWinners.push([...distinctValues.values()][0]);
    }

    // Then detect cross-slot ambiguity: the same utterance matching multiple slots
    // at the same priority must not be resolved by object insertion order.
    const byPhrase = new Map<string, MatchCandidate[]>();
    for (const candidate of slotWinners) {
      const group = byPhrase.get(candidate.matchedText) || [];
      group.push(candidate);
      byPhrase.set(candidate.matchedText, group);
    }

    const finalWinners: MatchCandidate[] = [];
    for (const group of byPhrase.values()) {
      if (group.length < 2) {
        finalWinners.push(...group);
        continue;
      }

      const maxPriority = Math.max(...group.map(candidate => candidate.priority));
      const highest = group.filter(candidate => candidate.priority === maxPriority);
      if (highest.length > 1) {
        return {
          status: 'AMBIGUOUS_SLOT',
          candidates: highest
            .sort((a, b) => a.slotName.localeCompare(b.slotName))
            .map(candidate => ({ slotName: candidate.slotName, value: candidate.value, scenarioId })),
          clarificationPrompt: ambiguityPromptTemplate
        };
      }

      // The same phrase matched multiple slots; honor the unique highest-priority
      // extractor instead of also returning lower-priority competing slots.
      finalWinners.push(highest[0]);
    }

    const slots: Record<string, any> = {};
    for (const candidate of finalWinners) {
      slots[candidate.slotName] = candidate.value;
    }
    return { status: 'RESOLVED', slots };
  }

  // Pure generic evaluation of query/comparison descriptors (100% Domain-Agnostic)
  private evaluateScenarioQuery(sc: ScenarioDefinition, candidates: CandidateItem[], extractedIndex?: number): any {
    const attribute = sc.evaluation?.attribute || sc.query?.attribute;
    const mode = sc.evaluation?.order || sc.query?.mode || 'min';
    const template = sc.evaluation?.responseTemplate || sc.responseTemplate || '';

    // 1. Comparison queries
    if (sc.query || sc.evaluation?.kind === 'compare') {
      const attr = attribute as string;

      const validItems = [...candidates].filter(o => {
        if (o.status && o.status !== 'AVAILABLE') return false;
        const val = o[attr];
        if (val === null || val === undefined || val === '') return false;
        const num = Number(val);
        return !isNaN(num) && isFinite(num);
      });

      if (validItems.length === 0) {
        return {
          status: 'INVALID_OFFER_DATA',
          intent: sc.intent,
          message: `Attribute "${attribute}" is missing or invalid in available candidate offers.`
        };
      }

      validItems.sort((a, b) => {
        const valA = Number(a[attr]);
        const valB = Number(b[attr]);
        return mode === 'max' ? valB - valA : valA - valB;
      });

      const best = validItems[0];
      let responseText = template;
      for (const [key, value] of Object.entries(best)) {
        responseText = responseText.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
      }

      const idField = sc.candidateBinding?.idField || Object.keys(best).find(k => k.endsWith('Id') || k === 'id') || 'id';
      const bestId = String(best[idField] ?? '');

      return {
        status: 'OFFER_COMPARISON_RESOLVED',
        intent: sc.intent,
        comparisonAttribute: (attribute || '').toUpperCase(),
        bestOfferId: bestId,
        [attribute || 'value']: best[attr],
        etaMinutes: best.etaMinutes,
        price: best.price,
        response: responseText
      };
    }

    // 2. Information questions on a specific candidate
    if (sc.evaluation?.kind === 'query_attribute') {
      const indexField = sc.candidateBinding?.indexField || 'index';
      const targetIndex = extractedIndex !== undefined ? extractedIndex : (sc.evaluation.targetIndex ?? 2);
      const target = candidates.find(o => o[indexField] === targetIndex);
      if (!target) return { status: 'NO_MATCH' };

      const distanceKm = typeof target.distanceKm === 'number' ? target.distanceKm : 0;
      const distanceMeters = distanceKm ? Math.round(distanceKm * 1000) : 0;
      let responseText = template;
      for (const [key, value] of Object.entries(target)) {
        responseText = responseText.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
      }
      responseText = responseText.replace(/{{distanceMeters}}/g, String(distanceMeters));

      const idField = sc.candidateBinding?.idField || Object.keys(target).find(k => k.endsWith('Id') || k === 'id') || 'id';
      const targetId = String(target[idField] ?? '');

      return {
        status: 'OFFER_QUERY_RESOLVED',
        intent: sc.intent,
        offerId: targetId,
        attributes: { ...target, distanceMeters },
        response: responseText
      };
    }

    return { status: 'RESOLVED', intent: sc.intent, scenarioId: sc.id };
  }

  // Pure Generic Candidate Resolution (Zero Domain-Specific Terms)
  public resolveCandidate(
    extractedSlots: Record<string, unknown>,
    candidates: CandidateItem[],
    binding: CandidateBindingDefinition | undefined,
    scenarioId: string,
    targetSlotName: string,
    ambiguityPrompt?: string
  ): CandidateResolutionResult {
    const idKey = binding?.idField || (candidates.length > 0 ? Object.keys(candidates[0]).find(k => k.endsWith('Id') || k === 'id') : undefined) || 'id';
    const indexKey = binding?.indexField || 'index';
    const statusKey = binding?.statusField || 'status';
    const unavailableVal = binding?.unavailableValue || 'UNAVAILABLE';
    const unavailTemplate = binding?.unavailableTemplate;
    const ambiguityTriggers = binding?.ambiguityTriggerValues || [];

    const hasAmbiguousCriteria = Object.values(extractedSlots).some(
      v => typeof v === 'string' && (ambiguityTriggers.includes(v) || v.toLowerCase().includes('ambiguous'))
    );

    if (hasAmbiguousCriteria) {
      const available = candidates.filter(c => c[statusKey] === undefined || c[statusKey] !== unavailableVal);
      if (available.length > 1) {
        return {
          status: 'AMBIGUOUS_SLOT',
          candidates: available.map(c => ({
            slotName: targetSlotName,
            value: String(c[idKey] ?? ''),
            scenarioId
          })),
          clarificationPrompt: ambiguityPrompt || 'Выберите, пожалуйста, конкретный вариант'
        };
      }
    }

    let matchedItem: CandidateItem | undefined;

    for (const val of Object.values(extractedSlots)) {
      if (typeof val === 'number') {
        matchedItem = candidates.find(c => c[indexKey] === val);
        if (matchedItem) break;
      } else if (typeof val === 'string' && val !== 'CONFIRMED' && val !== 'REJECTED') {
        const lowerVal = val.toLowerCase();
        matchedItem = candidates.find(c =>
          Object.values(c).some(prop => typeof prop === 'string' && prop.toLowerCase() === lowerVal)
        );
        if (matchedItem) break;
      }
    }

    if (!matchedItem) {
      return { status: 'NO_MATCH' };
    }

    const resolvedId = String(matchedItem[idKey] ?? '');

    if (matchedItem[statusKey] !== undefined && matchedItem[statusKey] === unavailableVal) {
      let unavailMsg = unavailTemplate || `Вариант ${resolvedId} более недоступен.`;
      unavailMsg = unavailMsg.replace(/{{targetId}}/g, resolvedId);

      return {
        status: 'CANDIDATE_UNAVAILABLE',
        targetId: resolvedId,
        targetItem: matchedItem,
        message: unavailMsg
      };
    }

    return {
      status: 'RESOLVED',
      targetId: resolvedId,
      targetItem: matchedItem
    };
  }

  public async handleIncomingVoice(phrase: string, identity: SessionIdentity): Promise<any> {
    if (!identity || !identity.ownerId || !identity.sessionId) {
      throw new Error('CONTRACT_VIOLATION: SessionIdentity is strictly required for handleIncomingVoice');
    }

    const text = phrase.trim().toLowerCase();
    const tokens = text.split(/\s+/);
    const sessionKey = `${identity.ownerId}\u0000${identity.sessionId}`;

    // 1. Cancellation Flow
    const isCancelToken = tokens.includes('отмена') || tokens.includes('отменить') || tokens.includes('cancel');
    if (isCancelToken) {
      const isPureCancel = text === 'отмена' || text === 'отменить' || text === 'cancel';
      const activeWaiting = this.dialogueManager.listContexts(identity).filter(c => c.status === 'WAITING_FOR_SLOT');

      if (isPureCancel) {
        const selectedContextId = this.explicitContextSelections.get(sessionKey);
        const selectedContext = selectedContextId
          ? this.dialogueManager.getContext(selectedContextId, identity)
          : undefined;
        if (selectedContext?.status === 'WAITING_FOR_SLOT') {
          this.explicitContextSelections.delete(sessionKey);
          return this.dialogueManager.cancelContext(selectedContext.contextId, identity);
        }
        if (activeWaiting.length === 1) {
          return this.dialogueManager.cancelContext(activeWaiting[0].contextId, identity);
        }
        if (activeWaiting.length > 1) {
          return {
            status: 'AMBIGUOUS_CONTEXT',
            candidateContextIds: activeWaiting.map(c => c.contextId)
          };
        }
        return { status: 'NO_MATCH' };
      }

      const routeResult = this.dialogueManager.resolveRouting(text, [], identity);
      if (routeResult.status === 'CONTEXT_ACCESS_DENIED') {
        return routeResult;
      }
      if (routeResult.status === 'RESOLVED') {
        this.explicitContextSelections.delete(`${identity.ownerId}\u0000${identity.sessionId}`);
        return this.dialogueManager.cancelContext(routeResult.contextId, identity);
      }
      return { status: 'NO_MATCH' };
    }

    // 2. Intent Resolution (Evaluation / Comparison Queries)
    const intentRes = this.resolveIntent(text);
    const isExplicitActivation = (() => {
      if (intentRes.status !== 'RESOLVED') return false;
      const sc = intentRes.scenario;
      const normalize = (value: string) =>
        value.replace(/^voice\./i, '').replace(/[-_]/g, ' ').toLowerCase().trim().replace(/\s+/g, ' ');
      const triggers = [
        sc.activation?.value,
        sc.expectedPhrase,
        ...(sc.triggerPhrases || []),
        ...(sc.aliases || [])
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      const normalizedText = normalize(text);
      return triggers.some(trigger => {
        const normalizedTrigger = normalize(trigger);
        return normalizedText === normalizedTrigger || normalizedText.startsWith(`${normalizedTrigger} `);
      });
    })();

    // Explicit references to another session's entity must be denied, not
    // downgraded to NO_MATCH merely because that context is filtered from reads.
    // A fresh activation is exempt: it may legitimately create a separate context
    // with the same external entity ID in another session.
    const ownershipRoute = this.dialogueManager.resolveRouting(text, [], identity);
    if (ownershipRoute.status === 'CONTEXT_ACCESS_DENIED' && !isExplicitActivation) {
      return ownershipRoute;
    }

    // A fresh explicit activation starts a new routing decision and must not
    // inherit a previous explicit context selection.
    if (intentRes.status === 'RESOLVED') {
      const sc = intentRes.scenario;
      const normalize = (value: string) =>
        value.replace(/^voice\./i, '').replace(/[-_]/g, ' ').toLowerCase().trim().replace(/\s+/g, ' ');
      const activationTriggers = [
        sc.activation?.value,
        sc.expectedPhrase,
        ...(sc.triggerPhrases || []),
        ...(sc.aliases || [])
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      const normalizedText = normalize(text);
      if (activationTriggers.some(trigger => {
        const normalizedTrigger = normalize(trigger);
        return normalizedText === normalizedTrigger || normalizedText.startsWith(`${normalizedTrigger} `);
      })) {
        this.explicitContextSelections.delete(sessionKey);
      }
    }

    if (intentRes.status === 'RESOLVED') {
      const sc = intentRes.scenario;

      if (sc.query || sc.evaluation) {
        let activeWaiting = this.dialogueManager.listContexts(identity).filter(c => c.status === 'WAITING_FOR_SLOT');
        const selectedContextId = this.explicitContextSelections.get(sessionKey);
        if (selectedContextId) {
          const selected = activeWaiting.find(context => context.contextId === selectedContextId);
          if (selected) activeWaiting = [selected];
          else this.explicitContextSelections.delete(sessionKey);
        }

        if (activeWaiting.length === 0) {
          return {
            status: 'CONTEXT_REQUIRED',
            message: 'No active offer context found for query'
          };
        }

        if (activeWaiting.length > 1) {
          return {
            status: 'AMBIGUOUS_CONTEXT',
            candidateContextIds: activeWaiting.map(c => c.contextId)
          };
        }

        const currentCtx = activeWaiting[0];
        if (!currentCtx.offers || currentCtx.offers.length === 0) {
          return { status: 'NO_MATCH' };
        }

        let extractedIdx: number | undefined;
        if (sc.slotExtractors) {
          const slotRes = this.extractSlotsDeterministically(text, sc.slotExtractors, sc.id);
          if (slotRes.status === 'RESOLVED') {
            const firstNumeric = Object.values(slotRes.slots).find(v => typeof v === 'number');
            if (typeof firstNumeric === 'number') {
              extractedIdx = firstNumeric;
            }
          }
        }

        return this.evaluateScenarioQuery(sc, currentCtx.offers as unknown as CandidateItem[], extractedIdx);
      }
    }

    // 3. Declarative Active Context Processing
    let activeWaiting = this.dialogueManager.listContexts(identity).filter(c => c.status === 'WAITING_FOR_SLOT');
    const selectedContextId = this.explicitContextSelections.get(sessionKey);
    if (selectedContextId) {
      const selected = activeWaiting.find(context => context.contextId === selectedContextId);
      if (selected) activeWaiting = [selected];
      else this.explicitContextSelections.delete(sessionKey);
    }

    // A repeated explicit activation with a different entity (for example,
    // "прими заказ 1002" while order 1001 is waiting for payment) starts a
    // separate context instead of overwriting the entity in the first order.
    if (intentRes.status === 'RESOLVED' && activeWaiting.length === 1) {
      const activeCtx = activeWaiting[0];
      const newScenario = intentRes.scenario;
      const normalize = (value: string) =>
        value.replace(/^voice\./i, '').replace(/[-_]/g, ' ').toLowerCase().trim().replace(/\s+/g, ' ');
      const activationTriggers = [
        newScenario.activation?.value,
        newScenario.expectedPhrase,
        ...(newScenario.triggerPhrases || []),
        ...(newScenario.aliases || [])
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      const normalizedText = normalize(text);
      const explicitActivation = activationTriggers.some(trigger => {
        const normalizedTrigger = normalize(trigger);
        return normalizedText === normalizedTrigger || normalizedText.startsWith(`${normalizedTrigger} `);
      });

      if (explicitActivation && activeCtx.scenarioId !== newScenario.id) {
        // A no-slot command supersedes the sole pending dialogue. A new slot-filling
        // scenario must preserve both contexts so the next utterance can be resolved
        // explicitly or reported as ambiguous.
        if (!newScenario.requiredSlots || newScenario.requiredSlots.length === 0) {
          await this.dialogueManager.cancelContext(activeCtx.contextId, identity);
          this.explicitContextSelections.delete(sessionKey);
        }
        activeWaiting = [];
      } else if (explicitActivation && activeCtx.scenarioId === newScenario.id && newScenario.slotExtractors) {
        const extractedStart = this.extractSlotsDeterministically(text, newScenario.slotExtractors, newScenario.id);
        if (extractedStart.status === 'RESOLVED') {
          const changedEntity = Object.entries(extractedStart.slots).some(([slotName, value]) =>
            activeCtx.slots[slotName] !== undefined && activeCtx.slots[slotName] !== value
          );
          if (changedEntity) activeWaiting = [];
        }
      }
    }

    if (activeWaiting.length === 1) {
      const activeCtx = activeWaiting[0];
      const scenario = (activeCtx.scenarioId ? this.scenarioRegistry.find(s => s.id === activeCtx.scenarioId) : undefined)
        || this.getDeterministicScenarioForIntent(activeCtx.intent);

      if (scenario && scenario.slotExtractors) {
        const slotRes = this.extractSlotsDeterministically(
          text,
          scenario.slotExtractors,
          scenario.id,
          scenario.ambiguityPrompt?.template
        );

        if (slotRes.status === 'AMBIGUOUS_SLOT') {
          return slotRes;
        }

        if (slotRes.status === 'RESOLVED' && Object.keys(slotRes.slots).length > 0) {
          const extracted = slotRes.slots;

          if (activeCtx.offers && activeCtx.offers.length > 0) {
            const targetSlot = scenario.candidateBinding?.targetSlot
              || activeCtx.missingSlots.find(s => s !== 'confirmation') 
              || activeCtx.requiredSlots?.find(s => s !== 'confirmation');

            if (targetSlot) {
              const candidateResolution = this.resolveCandidate(
                extracted,
                activeCtx.offers as unknown as CandidateItem[],
                scenario.candidateBinding,
                scenario.id,
                targetSlot,
                scenario.ambiguityPrompt?.template
              );

              if (candidateResolution.status === 'AMBIGUOUS_SLOT') {
                return {
                  status: 'AMBIGUOUS_SLOT',
                  candidates: candidateResolution.candidates,
                  clarificationPrompt: candidateResolution.clarificationPrompt
                };
              }

              if (candidateResolution.status === 'CANDIDATE_UNAVAILABLE') {
                // Keep the resolver's generic status internal, but expose the
                // passenger-offer contract status at the voice-channel boundary.
                return {
                  status: 'OFFER_UNAVAILABLE',
                  targetId: candidateResolution.targetId,
                  offerId: candidateResolution.targetId,
                  message: candidateResolution.message
                };
              }

              // Do not silently return the unchanged context when the user explicitly
              // referred to a candidate that is not present in this OfferSet.
              if (
                candidateResolution.status === 'NO_MATCH' &&
                Object.values(extracted).some(value => value !== 'CONFIRMED' && value !== 'REJECTED')
              ) {
                return { status: 'NO_MATCH' };
              }

              if (candidateResolution.status === 'RESOLVED' && candidateResolution.targetId) {
                const fillRes = await this.dialogueManager.fillSlot(targetSlot, candidateResolution.targetId, activeCtx.contextId, identity);
                if (fillRes.success) {
                  return fillRes.data;
                }
              }
            }
          }

          let updatedCtxState: any = null;
          for (const [slotKey, slotVal] of Object.entries(extracted)) {
            if (slotKey !== 'confirmation' && (activeCtx.missingSlots.includes(slotKey) || activeCtx.slots[slotKey] !== undefined)) {
              const fillRes = await this.dialogueManager.fillSlot(slotKey, slotVal, activeCtx.contextId, identity);
              if (fillRes.success) {
                updatedCtxState = fillRes.data;
              }
            }
          }

          if (extracted.confirmation === 'REJECTED') {
            return {
              status: 'SELECTION_REJECTED',
              contextId: activeCtx.contextId,
              slots: this.dialogueManager.getContext(activeCtx.contextId, identity)?.slots,
              message: 'Выбор не подтвержден. Вы можете выбрать другой вариант.'
            };
          }

          if (extracted.confirmation === 'CONFIRMED') {
            const currentCtx = this.dialogueManager.getContext(activeCtx.contextId, identity) || activeCtx;
            const remainingNonConfirm = currentCtx.missingSlots.filter(s => s !== 'confirmation');

            if (remainingNonConfirm.length === 0) {
              const fillRes = await this.dialogueManager.fillSlot('confirmation', 'CONFIRMED', currentCtx.contextId, identity);
              if (fillRes.success) {
                const updated = fillRes.data;
                const eventPayload = scenario.steps?.find(st => st.kind === 'emit')?.event?.payload || {};
                const exec = this.dialogueManager.createExecution(updated, identity, undefined, eventPayload);
                const dispatchRes = await this.dialogueManager.dispatchAction(exec.executionId, exec.payload, identity);
                return {
                  status: dispatchRes.status === 'SUCCEEDED' ? 'COMPLETED' : dispatchRes.status,
                  intent: updated.intent,
                  contextId: updated.contextId,
                  executionId: exec.executionId,
                  attempt: dispatchRes.attempt,
                  context: this.dialogueManager.getContext(updated.contextId, identity)
                };
              }
            }
          }

          const currentCtx = this.dialogueManager.getContext(activeCtx.contextId, identity);
          const requiresConfirmation = scenario.requiredSlots?.includes('confirmation')
            || activeCtx.missingSlots.includes('confirmation');

          if (updatedCtxState && currentCtx && currentCtx.missingSlots.length === 0 && !requiresConfirmation) {
            if (!this.dialogueManager.hasActionDispatcher()) {
              await this.dialogueManager.handleSystemEvent(
                currentCtx.contextId,
                { type: 'DIALOGUE_COMPLETED', targetTransition: 'COMPLETE' },
                identity
              );
              return {
                status: 'COMPLETED',
                contextId: currentCtx.contextId,
                slots: currentCtx.slots,
                context: this.dialogueManager.getContext(currentCtx.contextId, identity)
              };
            }

            const eventPayload = scenario.steps?.find(st => st.kind === 'emit')?.event?.payload || {};
            const execution = this.dialogueManager.createExecution(currentCtx, identity, undefined, eventPayload);
            const dispatchResult = await this.dialogueManager.dispatchAction(execution.executionId, execution.payload, identity);
            return {
              status: dispatchResult.status === 'SUCCEEDED' ? 'COMPLETED' : dispatchResult.status,
              intent: currentCtx.intent,
              contextId: currentCtx.contextId,
              executionId: execution.executionId,
              attempt: dispatchResult.attempt,
              slots: currentCtx.slots,
              context: this.dialogueManager.getContext(currentCtx.contextId, identity)
            };
          }

          return updatedCtxState || currentCtx;
        }
      }
    } else if (activeWaiting.length > 1) {
      const contextMatches: Array<{
        contextId: string;
        slotNames: string[];
        candidates: Array<{ slotName: string; value: any; scenarioId: string }>;
        clarificationPrompt?: string;
        ambiguousSlot: boolean;
      }> = [];

      for (const ctx of activeWaiting) {
        const scenario = (ctx.scenarioId ? this.scenarioRegistry.find(s => s.id === ctx.scenarioId) : undefined)
          || this.getDeterministicScenarioForIntent(ctx.intent);
        if (!scenario?.slotExtractors) continue;

        const extraction = this.extractSlotsDeterministically(
          text,
          scenario.slotExtractors,
          scenario.id,
          scenario.ambiguityPrompt?.template
        );

        if (extraction.status === 'AMBIGUOUS_SLOT') {
          contextMatches.push({
            contextId: ctx.contextId,
            slotNames: [...new Set(extraction.candidates.map(candidate => candidate.slotName))],
            candidates: extraction.candidates,
            clarificationPrompt: extraction.clarificationPrompt,
            ambiguousSlot: true
          });
          continue;
        }

        if (extraction.status !== 'RESOLVED') continue;
        const matchingSlots = Object.entries(extraction.slots)
          .filter(([slotName, value]) =>
            ctx.missingSlots.includes(slotName) || ctx.slots[slotName] === value
          );
        if (matchingSlots.length === 0) continue;

        contextMatches.push({
          contextId: ctx.contextId,
          slotNames: matchingSlots.map(([slotName]) => slotName),
          candidates: matchingSlots.map(([slotName, value]) => ({ slotName, value, scenarioId: scenario.id })),
          clarificationPrompt: scenario.ambiguityPrompt?.template,
          ambiguousSlot: false
        });
      }

      if (contextMatches.length > 1) {
        const slotNames = [...new Set(contextMatches.flatMap(match => match.slotNames))];
        if (slotNames.length > 1) {
          return {
            status: 'AMBIGUOUS_SLOT',
            candidates: contextMatches.flatMap(match => match.candidates),
            clarificationPrompt: contextMatches.find(match => match.clarificationPrompt)?.clarificationPrompt
          };
        }
        const matchedContexts = contextMatches
          .map(match => this.dialogueManager.getContext(match.contextId, identity))
          .filter((ctx): ctx is DialogueContext => ctx !== undefined);
        const labels = matchedContexts.map(ctx => {
          const orderId = ctx.slots.orderId ?? ctx.slots.order_id;
          return orderId !== undefined ? `заказ ${orderId}` : ctx.intent;
        });
        return {
          status: 'AMBIGUOUS_CONTEXT',
          candidateContextIds: contextMatches.map(match => match.contextId),
          clarificationPrompt: `Уточните, пожалуйста, к какому заказу относится ответ: ${labels.join(' или ')}`
        };
      }

      if (contextMatches.length === 1 && contextMatches[0].ambiguousSlot) {
        return {
          status: 'AMBIGUOUS_SLOT',
          candidates: contextMatches[0].candidates,
          clarificationPrompt: contextMatches[0].clarificationPrompt
        };
      }

      if (contextMatches.length === 1) {
        const match = contextMatches[0];
        const targetContext = this.dialogueManager.getContext(match.contextId, identity);
        const explicitlyReferencesExistingSlot = targetContext && match.candidates.some(candidate =>
          !targetContext.missingSlots.includes(candidate.slotName) &&
          targetContext.slots[candidate.slotName] === candidate.value
        );

        if (targetContext && explicitlyReferencesExistingSlot) {
          this.dialogueManager.activateContext(targetContext.contextId, identity);
          this.explicitContextSelections.set(sessionKey, targetContext.contextId);
          return {
            status: targetContext.status,
            contextId: targetContext.contextId,
            slots: targetContext.slots,
            missingSlots: targetContext.missingSlots,
            clarificationPrompt: targetContext.clarificationPrompt
          };
        }
      }
    }

    // 4. Initial Context Creation
    if (intentRes.status === 'RESOLVED') {
      const sc = intentRes.scenario;
      const emitStep = sc.steps?.find(st => st.kind === 'emit');
      const actionType = emitStep?.event?.type || `${sc.intent.toLowerCase()}.action`;
      const requiredSlots = sc.requiredSlots || [];
      const prompts = sc.clarificationPrompts || {};

      const activationTriggers = [
        sc.activation?.value,
        sc.expectedPhrase,
        ...(sc.triggerPhrases || []),
        ...(sc.aliases || [])
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      const normalizeTrigger = (value: string) =>
        value.replace(/^voice\./i, '').replace(/[-_]/g, ' ').toLowerCase().trim().replace(/\s+/g, ' ');
      const activationOnly = activationTriggers.some(trigger => normalizeTrigger(text) === normalizeTrigger(trigger));
      const extractorsForInitialCommand = activationOnly && sc.slotExtractors
        ? Object.fromEntries(Object.entries(sc.slotExtractors).filter(([, extractor]) =>
            !(extractor.type === 'string' && !extractor.pattern && !extractor.rules)
          ))
        : sc.slotExtractors;
      const slotRes = this.extractSlotsDeterministically(
        text,
        extractorsForInitialCommand,
        sc.id,
        sc.ambiguityPrompt?.template
      );

      if (slotRes.status === 'AMBIGUOUS_SLOT') {
        return slotRes;
      }

      const initialSlots = slotRes.status === 'RESOLVED' ? slotRes.slots : {};

      // A repeated explicit activation with the same fully specified entity must
      // not dispatch the already-completed action a second time in this session.
      // Only suppress it when the earlier context has a successful execution log;
      // failed/unknown executions remain eligible for the existing recovery path.
      const hasAllRequiredSlots = requiredSlots.every(slot => initialSlots[slot] !== undefined);
      if (hasAllRequiredSlots && requiredSlots.length > 0) {
        const completedDuplicate = this.dialogueManager.listContexts(identity).find(context =>
          context.status === 'COMPLETED' &&
          context.scenarioId === sc.id &&
          requiredSlots.every(slot => context.slots[slot] === initialSlots[slot])
        );
        if (completedDuplicate) {
          const priorSuccess = this.dialogueManager.getExecutionLogs(identity).find(entry =>
            entry.contextId === completedDuplicate.contextId && entry.status === 'SUCCEEDED'
          );
          if (priorSuccess) {
            return {
              status: 'COMPLETED',
              intent: completedDuplicate.intent,
              contextId: completedDuplicate.contextId,
              executionId: priorSuccess.executionId,
              context: completedDuplicate,
              duplicate: true
            };
          }
        }
      }

      const ctx = this.dialogueManager.createContext(
        sc.intent,
        initialSlots,
        requiredSlots,
        actionType,
        prompts,
        identity,
        sc.id
      );

      if (ctx.missingSlots.length === 0) {
        const eventPayload = sc.steps?.find(st => st.kind === 'emit')?.event?.payload || {};
        const exec = this.dialogueManager.createExecution(ctx, identity, undefined, eventPayload);
        const dispatchRes = await this.dialogueManager.dispatchAction(exec.executionId, exec.payload, identity);
        return {
          status: dispatchRes.status === 'SUCCEEDED' ? 'COMPLETED' : dispatchRes.status,
          intent: ctx.intent,
          contextId: ctx.contextId,
          executionId: exec.executionId,
          attempt: dispatchRes.attempt,
          context: this.dialogueManager.getContext(ctx.contextId, identity)
        };
      }

      return ctx;
    }
    if (intentRes.status === 'AMBIGUOUS_INTENT') {
      return intentRes;
    }

    return { status: 'NO_MATCH' };
  }

  public getScenarioById(id: string): ScenarioDefinition | undefined {
    return this.scenarioRegistry.find(s => s.id === id);
  }

  public getScenarioRegistry(): ScenarioDefinition[] {
    return [...this.scenarioRegistry];
  }

}
