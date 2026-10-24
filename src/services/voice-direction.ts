import type { Character, Project, Scene } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseJson } from "@/lib/utils";
import { projectContent } from "@/domain/content-legacy";
import { languageOf } from "@/domain/content-options";
import { controlsOf } from "@/domain/output-controls";
import { isNarrator, sceneCharacters, type SceneCharacterColumns } from "@/domain/scene-characters";
import { parseDialogueLines } from "@/domain/dialogue-lines";
import type { ScriptDoc } from "@/domain/script";
import { prepareSpeechText, speechLanguageOf, type SpeechLanguage } from "@/domain/speech-text";
import {
  autoPresetFor,
  directVoice,
  voicePresetOf,
  voiceStyleFor,
  type DirectedVoice,
  type VoiceIdentity,
  type VoiceTimbre,
} from "@/domain/voice-director";
import {
  CIT_AUTO_VOICE,
  CIT_PROVIDER,
  citDirection,
  citDirectionSummary,
  citLanguageFor,
  clampCitSpeed,
  pickCitVoice,
  type CitEngineId,
} from "@/domain/cit";
import {
  clampMindSpeed,
  engineForLanguage,
  MIND_AUTO_VOICE,
  MIND_PROVIDER,
  mindDirection,
  mindDirectionSummary,
  pickMindVoice,
  type MindEngineId,
} from "@/domain/mind-voice";
import { dialogueDirection, speakerEmotionOf, type DialogueEmotionId } from "@/domain/dialogue-director";
import { OPENAI_VOICES } from "@/providers/openai/openai-voice-client";
import { cachedCitCatalog, engineOfVoice, type CitCatalog } from "./cit-catalog";
import { cachedMindCatalog, engineOfMindVoice, variantOfMindEngine, type MindCatalog } from "./mind-voice-catalog";

/**
 * VOICE DIRECTOR, wired to a scene (QĐ-142).
 *
 * Every place that asks "what would this line be spoken as?" - making the voice,
 * planning it, pricing it, checking it for reuse - goes through `direct`, so the
 * preview, the run, the resume and every render agree on the same request and
 * therefore on the same audio. A project without the director (every project
 * made before QĐ-142) gets its settings back untouched.
 */

/** The fields of a line's voice settings the director may change. */
export interface LineVoiceSettings {
  voiceId: string;
  instructions: string;
  speed: number;
  model: string | null;
  /** Who speaks it (QĐ-144: CIT gets its own adapter). Absent = not known here. */
  provider?: string | null;
  /** QĐ-158: the language the speaker's chosen voice speaks; null/absent = from the project and the text. */
  speechLanguage?: SpeechLanguage | null;
  /** QĐ-158: why the speaker's OWN saved voice cannot speak (null = fine). */
  voiceProblem?: string | null;
}

export interface Directed {
  /** Exactly what is sent to the voice model; absent = the line's own words. */
  spokenText?: string;
  directed?: DirectedVoice;
  /** Language code sent to a provider that takes one (CIT, Mind Voice). */
  language?: string;
}

type SceneInput = Pick<Scene, "dialogue" | "narration"> &
  Partial<Pick<Scene, "id" | "projectId" | "sceneNumber" | "duration">> &
  SceneCharacterColumns;

/**
 * Voices only gpt-4o-mini-tts has. A pin to an older TTS model (tts-1) gets its
 * nearest classic voice instead of a request the vendor would reject.
 */
const CLASSIC_EQUIVALENT: Record<string, string> = { marin: "nova", cedar: "onyx", verse: "echo", ballad: "fable" };

function timbreOf(narrator: Pick<Character, "voiceGender"> | null): VoiceTimbre {
  return narrator?.voiceGender === "male" ? "male" : "female";
}

/** The director for one scene: a function from (line, its base settings) to the settings to use. */
export async function voiceDirectorFor(
  scene: SceneInput,
): Promise<<T extends LineVoiceSettings>(line: { speaker: string; text: string }, base: T) => T & Directed> {
  const untouched = <T extends LineVoiceSettings>(_line: { speaker: string; text: string }, base: T) => base as T & Directed;
  if (!scene.projectId) return untouched;
  const project = await prisma.project.findUnique({ where: { id: scene.projectId } });
  if (!project) return untouched;
  const voice = controlsOf(project).voice;
  const content = projectContent(project);
  // CIT Voice Studio (QĐ-144) gets its own adapter, director on or off.
  const catalog = await cachedCitCatalog();
  const mindCatalog = await cachedMindCatalog();
  // QĐ-147: a character's own emotion in a Mind Voice dialogue; null = Dialogue Director off, or the narrator.
  const dialogueEmotion = (speaker: string): DialogueEmotionId | null =>
    voice.dialogueDirector && !isNarrator(speaker) ? speakerEmotionOf(voice.speakerEmotions, scene.id ?? null, speaker) : null;
  // A local engine (CIT legacy, Mind Voice QĐ-145) gets its own adapter; null = not local.
  const local = <T extends LineVoiceSettings>(line: { speaker: string; text: string }, base: T, directed: DirectedVoice | null): (T & Directed) | null =>
    base.provider === CIT_PROVIDER
      ? citDirected(line, base, directed, content.language, catalog)
      : base.provider === MIND_PROVIDER
        ? mindDirected(line, base, directed, content.language, mindCatalog, voice.emotionCues, dialogueEmotion(line.speaker))
        : null;
  if (!voice.director) {
    return <T extends LineVoiceSettings>(line: { speaker: string; text: string }, base: T) => local(line, base, null) ?? (base as T & Directed);
  }

  const context = await sceneContext(project, scene);
  const narrator = await prisma.character.findUnique({ where: { name: "Narrator" } });
  const styleId = voiceStyleFor(content.creative, content.legacy ? null : content.contentType);
  const preset = voicePresetOf(voice.preset) ?? autoPresetFor(styleId, timbreOf(narrator));
  const emotion = (scene.id ? voice.sceneEmotions[scene.id] : undefined) ?? voice.emotion;
  const cps = languageOf(content.language).charsPerSecond;
  const speech = parseDialogueLines(scene.dialogue, scene.narration, sceneCharacters(scene).speaking);

  return <T extends LineVoiceSettings>(line: { speaker: string; text: string }, base: T): T & Directed => {
    const narrated = isNarrator(line.speaker);
    // Who picks the narrator's voice (QĐ-158), first match wins:
    //   1. a voice this project chose (VIDEO OUTPUT)          - the person asked
    //   2. the narrator's LOCKED voice (a language was chosen) - kept, never swapped
    //   3. the director's preset                               - only when nothing is locked
    // `speechLanguage` is set only for a locked voice that no project choice replaced.
    const locked = narrated && !voice.voiceId && base.speechLanguage != null;
    if (narrated && !locked) base = { ...base, speechLanguage: null, voiceProblem: null };
    const language = base.speechLanguage ?? speechLanguageOf(content.language, line.text);
    const spokenText = prepareSpeechText(line.text, language);
    const identity: VoiceIdentity = narrated
      ? {
          voiceId: voice.voiceId ?? (locked ? base.voiceId : preset.voiceId),
          base: preset.base,
          speed: voice.speed,
          presetSpeed: preset.defaultSpeed,
          presetLabel: preset.label,
        }
      : {
          // A character keeps its own voice and direction in every scene.
          voiceId: base.voiceId,
          base: base.instructions.trim() || "A natural, expressive voice.",
          speed: Math.abs(base.speed - 1) > 1e-9 ? base.speed : null,
          presetSpeed: 1,
          presetLabel: null,
        };
    const directed = directVoice({
      identity,
      style: content.creative,
      contentType: content.legacy ? null : content.contentType,
      sceneRole: context.role,
      sceneIndex: context.index,
      sceneCount: context.count,
      sceneDuration: scene.duration ?? 0,
      sceneSpeechChars: speech.reduce((n, l) => n + prepareSpeechText(l.text, speechLanguageOf(content.language, l.text)).length, 0),
      language,
      emotion,
      speedMode: voice.speedMode,
      custom: narrated ? voice.instructions : null,
      narrator: narrated,
      charsPerSecond: cps,
    });
    const localLine = local(line, { ...base, speed: directed.speed }, directed);
    if (localLine) return localLine;
    const classic = base.model && /^tts-1/.test(base.model) ? CLASSIC_EQUIVALENT[identity.voiceId] : undefined;
    return {
      ...base,
      voiceId: classic ?? identity.voiceId,
      instructions: directed.instructions,
      speed: directed.speed,
      spokenText,
      directed,
    };
  };
}

const NOT_CIT_VOICES = new Set<string>(OPENAI_VOICES.map((v) => v.id));

/**
 * A line spoken by CIT Voice Studio (QĐ-144). The OpenAI `instructions` are
 * NOT sent; the director's intent becomes CIT's own inline tags in the text
 * (see citDirection), and `instructions` records the CIT direction for the
 * voice key and the line row. Engine and voice come from the KEPT catalog, so
 * the key does not depend on whether CIT is open right now.
 */
function citDirected<T extends LineVoiceSettings>(
  line: { speaker: string; text: string },
  base: T,
  directed: DirectedVoice | null,
  projectLanguage: string,
  catalog: CitCatalog | null,
): T & Directed {
  const lineLanguage = base.speechLanguage ?? speechLanguageOf(projectLanguage, line.text);
  const language = citLanguageFor(projectLanguage, lineLanguage);
  const known = catalog?.voices.some((v) => v.id === base.voiceId) ?? false;
  // A voice id CIT does not have (an OpenAI or mock voice left on the narrator) means "Tự động".
  const foreign = !base.voiceId || NOT_CIT_VOICES.has(base.voiceId) || base.voiceId.startsWith("mock-");
  const chosen = known || (!catalog?.voices.length && !foreign) ? base.voiceId : CIT_AUTO_VOICE;
  let voiceId = chosen;
  let engine: CitEngineId = engineOfVoice(catalog, chosen);
  if (chosen === CIT_AUTO_VOICE) {
    const pick = catalog ? pickCitVoice(catalog.voices, catalog.health, language) : null;
    if (pick?.ok) {
      voiceId = pick.voice.id;
      engine = pick.voice.engine;
    } else {
      // Resolved by CIT at generation time; the language decides the engine.
      engine = language === "vi" ? "VIENEU" : language === "en" ? "SUPERTONIC" : "UNKNOWN";
    }
  }
  const tagged = citDirection({
    text: prepareSpeechText(line.text, lineLanguage),
    engine,
    style: directed?.styleId ?? null,
    role: directed?.role ?? null,
    emotion: directed?.emotion ?? null,
  });
  return {
    ...base,
    voiceId,
    speed: clampCitSpeed(base.speed),
    instructions: citDirectionSummary({ engine, language, style: directed?.styleId ?? null, role: directed?.role ?? null, emotion: directed?.emotion ?? null }),
    spokenText: tagged.text,
    language,
    ...(directed ? { directed } : {}),
  };
}

/** The scene's role (from the written script) and where it sits in the video. */
async function sceneContext(project: Project, scene: SceneInput): Promise<{ role: string | null; index: number; count: number }> {
  const doc = parseJson<Partial<ScriptDoc> | null>(project.scriptJson, null);
  const role = (doc?.scenes ?? []).find((s) => s.sceneNumber === scene.sceneNumber)?.sceneRole ?? null;
  const order = await prisma.scene.findMany({
    where: { projectId: project.id, skipped: false },
    orderBy: { sceneNumber: "asc" },
    select: { sceneNumber: true },
  });
  const index = Math.max(0, order.findIndex((s) => s.sceneNumber === scene.sceneNumber));
  return { role, index, count: order.length };
}

/**
 * A line spoken by Mind Voice (QĐ-145). Same contract as CIT: no OpenAI
 * `instructions`; the director's intent becomes the engine's own inline cues
 * (mindDirection); `instructions` records engine, model variant, language and
 * direction for the voice key. Voice, engine and variant come from the KEPT
 * catalog, so the key does not depend on whether Mind Voice is running.
 */
function mindDirected<T extends LineVoiceSettings>(
  line: { speaker: string; text: string },
  base: T,
  directed: DirectedVoice | null,
  projectLanguage: string,
  catalog: MindCatalog | null,
  cues: boolean,
  dialogue: DialogueEmotionId | null,
): T & Directed {
  const language = base.speechLanguage ?? speechLanguageOf(projectLanguage, line.text);
  const known = engineOfMindVoice(catalog, base.voiceId);
  let voiceId = known ? base.voiceId : MIND_AUTO_VOICE;
  let engine: MindEngineId = known ?? engineForLanguage(language) ?? "vieneu";
  if (!known) {
    const pick = catalog ? pickMindVoice(catalog.voices, language) : null;
    if (pick?.ok) {
      voiceId = pick.voice.id;
      engine = pick.voice.engine;
    }
    // else: resolved by the service at generation time ("AUTO"), engine by language.
  }
  const tagged = mindDirection({
    text: prepareSpeechText(line.text, language),
    engine,
    style: directed?.styleId ?? null,
    role: directed?.role ?? null,
    emotion: directed?.emotion ?? null,
    cues,
  });
  // QĐ-147: this speaker's own emotion, as far as the engine really goes (dialogue-director.ts).
  const spoken = dialogue ? dialogueDirection({ text: tagged.text, engine, emotion: dialogue, cues }) : null;
  const summary = mindDirectionSummary({
    engine,
    variant: variantOfMindEngine(catalog, engine),
    language,
    style: directed?.styleId ?? null,
    role: directed?.role ?? null,
    emotion: directed?.emotion ?? null,
    cues,
  });
  return {
    ...base,
    voiceId,
    speed: clampMindSpeed(base.speed * (spoken?.tempo ?? 1)),
    instructions: spoken ? `${summary} ${spoken.summary}` : summary,
    spokenText: spoken?.text ?? tagged.text,
    language,
    ...(directed ? { directed } : {}),
  };
}
