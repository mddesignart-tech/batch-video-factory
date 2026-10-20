import type { Character, Project, Scene } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseJson } from "@/lib/utils";
import { projectContent } from "@/domain/content-legacy";
import { languageOf } from "@/domain/content-options";
import { controlsOf } from "@/domain/output-controls";
import { isNarrator, sceneCharacters, type SceneCharacterColumns } from "@/domain/scene-characters";
import { parseDialogueLines } from "@/domain/dialogue-lines";
import type { ScriptDoc } from "@/domain/script";
import { prepareSpeechText, speechLanguageOf } from "@/domain/speech-text";
import {
  autoPresetFor,
  directVoice,
  voicePresetOf,
  voiceStyleFor,
  type DirectedVoice,
  type VoiceIdentity,
  type VoiceTimbre,
} from "@/domain/voice-director";

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
}

export interface Directed {
  /** Exactly what is sent to the voice model; absent = the line's own words. */
  spokenText?: string;
  directed?: DirectedVoice;
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
  if (!voice.director) return untouched;

  const context = await sceneContext(project, scene);
  const narrator = await prisma.character.findUnique({ where: { name: "Narrator" } });
  const content = projectContent(project);
  const styleId = voiceStyleFor(content.creative, content.legacy ? null : content.contentType);
  const preset = voicePresetOf(voice.preset) ?? autoPresetFor(styleId, timbreOf(narrator));
  const emotion = (scene.id ? voice.sceneEmotions[scene.id] : undefined) ?? voice.emotion;
  const cps = languageOf(content.language).charsPerSecond;
  const speech = parseDialogueLines(scene.dialogue, scene.narration, sceneCharacters(scene).speaking);

  return <T extends LineVoiceSettings>(line: { speaker: string; text: string }, base: T): T & Directed => {
    const narrated = isNarrator(line.speaker);
    const language = speechLanguageOf(content.language, line.text);
    const spokenText = prepareSpeechText(line.text, language);
    const identity: VoiceIdentity = narrated
      ? {
          voiceId: voice.voiceId ?? preset.voiceId,
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
