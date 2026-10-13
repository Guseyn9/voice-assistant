import { DialogueStateManager, ActionDispatcher } from '../../../src/platform/dialogue-manager';
import { VoiceChannel } from '../../../src/platform/voice-channel';

export function initializeVoicePlatform(dispatcher?: ActionDispatcher) {
  if (!dispatcher) {
    throw new Error('CONTRACT_VIOLATION: ActionDispatcher is strictly required to initialize Voice Platform in production');
  }

  const dialogueManager = new DialogueStateManager({
    maxActiveContexts: 50,
    defaultTtlMs: 300000,
    actionDispatcher: dispatcher
  });

  const voiceChannel = new VoiceChannel(dialogueManager);

  if (typeof window !== 'undefined') {
    (window as any).__DIALOGUE_MANAGER__ = dialogueManager;
    (window as any).__VOICE_CHANNEL__ = voiceChannel;
  }

  return { dialogueManager, voiceChannel };
}

// Named alias for backward-compatible entrypoints
export const bootstrap = initializeVoicePlatform;
