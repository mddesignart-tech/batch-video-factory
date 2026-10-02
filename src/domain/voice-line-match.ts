/**
 * Is a stored dialogue line still the audio this line would be bought as now?
 *
 * Only what changes the AUDIO counts: the words, the voice, the speaking
 * instructions, the speed and - when a provider/model is pinned or routed - the
 * model that speaks it. The scene, project, picture, clip prompt, camera and
 * subtitle are deliberately absent: changing them never re-buys a voice.
 *
 * The same rule the voice reuse key encodes (voiceReuseKey), applied to the
 * row's recorded fields so it can be checked without hashing anything.
 */
export interface VoiceRowFields {
  status: string;
  text: string;
  voiceId: string;
  instructions: string;
  speed: number;
  provider: string;
  model: string;
  outputPath: string;
}

export interface VoiceLineSettings {
  voiceId: string;
  instructions: string;
  speed: number;
  /** Null when the router chooses; a value pins it. */
  provider: string | null;
  model: string | null;
}

export function voiceRowMatches(
  row: VoiceRowFields,
  text: string,
  settings: VoiceLineSettings,
  routed?: { provider: string; model: string } | null,
): boolean {
  if (row.status !== "completed" || !row.outputPath) return false;
  if (row.text !== text) return false;
  if (row.voiceId !== settings.voiceId) return false;
  if ((row.instructions ?? "") !== (settings.instructions ?? "")) return false;
  if (Math.abs((row.speed ?? 1) - (settings.speed ?? 1)) > 1e-9) return false;
  const provider = routed?.provider ?? settings.provider;
  const model = routed?.model ?? settings.model;
  if (provider && row.provider !== provider) return false;
  if (model && row.model !== model) return false;
  return true;
}
