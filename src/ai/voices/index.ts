import { FJC_SCOPE_VOICE_V2 } from './fjc-scope.v2';
import type { ScopeVoice } from './types';

export type { ScopeVoice, VoiceExample, VoiceGroup } from './types';

/**
 * The voice used for a business's scope wording. FJC is the only business so far, so every business gets FJC's
 * generic voice (verbs and trade nouns only, no FJC facts). When a second business needs its own, key this by tenant.
 */
export function scopeVoiceFor(_tenantId?: string): ScopeVoice {
  return FJC_SCOPE_VOICE_V2;
}

export { FJC_SCOPE_VOICE_V2 };
