import { DialogueStateManager, type SessionIdentity } from './dialogue-manager';
import { VoiceChannel, type ScenarioDefinition } from './voice-channel';
import {
  DialogueEngine,
  type DialogueInput,
  type DialoguePresentation,
  type DialoguePresentationAction,
  type DialogueEngineResult
} from './dialogue-channel';

export {
  type DialoguePresentation,
  type DialoguePresentationAction
};

export interface TelegramInputMessage {
  channel: 'button' | 'text' | 'voice';
  raw_input?: string;
  transcript?: string;
  button_payload?: {
    slotName?: string;
    slotValue?: any;
    action?: string;
  };
}

export interface DialogueInstrumentation {
  channel: 'button' | 'text' | 'voice';
  raw_input: string | null;
  transcript: string | null;
  intent: string | null;
  extracted_slots: Record<string, any>;
  previous_state: Record<string, any>;
  new_state: Record<string, any>;
  next_question: string | null;
  confidence: number;
}

export type DialogueAdapterResult = DialogueEngineResult;

export class TelegramDialogueAdapter {
  private engine: DialogueEngine;
  private lastInstrumentation: DialogueInstrumentation | null = null;

  constructor(dm: DialogueStateManager, vc: VoiceChannel) {
    this.engine = new DialogueEngine(dm, vc);
  }

  public getDialogueEngine(): DialogueEngine {
    return this.engine;
  }

  public getLastInstrumentation(): DialogueInstrumentation | null {
    return this.lastInstrumentation;
  }

  public async handleMessage(
    input: TelegramInputMessage,
    identity: SessionIdentity,
    activeScenario?: ScenarioDefinition
  ): Promise<DialogueAdapterResult> {
    const dm = this.engine.getDialogueManager();
    const activeCtxBefore = dm.getActiveState(identity);
    const prevState = activeCtxBefore ? { ...activeCtxBefore.slots } : {};

    const dialogueInput: DialogueInput = {
      modality: input.channel,
      channel: input.channel,
      raw_input: input.raw_input,
      transcript: input.transcript,
      payload: input.button_payload ? {
        slotName: input.button_payload.slotName,
        slotValue: input.button_payload.slotValue,
        action: input.button_payload.action
      } : undefined
    };

    const res = await this.engine.processInput(dialogueInput, identity, activeScenario);

    const activeCtxAfter = dm.getActiveState(identity);
    const newState = activeCtxAfter ? { ...activeCtxAfter.slots } : (res.slots || {});

    const extractedSlots: Record<string, any> = {};
    for (const [slotName, value] of Object.entries(newState)) {
      if (prevState[slotName] !== value) {
        extractedSlots[slotName] = value;
      }
    }

    this.lastInstrumentation = {
      channel: input.channel,
      raw_input: input.raw_input || null,
      transcript: input.transcript || null,
      intent: activeCtxAfter?.intent || activeScenario?.intent || null,
      extracted_slots: extractedSlots,
      previous_state: prevState,
      new_state: newState,
      next_question: res.nextQuestion || null,
      confidence: 1.0
    };

    // The Telegram-facing order contract retains its established terminal status.
    return res.status === 'CONFIRMED' && (activeCtxAfter?.intent || activeScenario?.intent || activeCtxBefore?.intent) === 'ORDER_NANNY'
      ? { ...res, status: 'ORDER_CONFIRMED' }
      : res;
  }
}
