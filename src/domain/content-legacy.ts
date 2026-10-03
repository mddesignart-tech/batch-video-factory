/**
 * How a project's content settings are READ - old and new alike.
 *
 * A project made before the multi-content engine has every new column NULL.
 * It is read as an English idiom video with the original writer, and nothing
 * is written back: opening, rendering or reusing it behaves exactly as before.
 *
 * Pure: takes the columns, returns the effective settings.
 */

import { audienceOf, toneOf, type VoiceMode } from "./content-options";
import {
  LEGACY_CONTENT_TYPE,
  formatOf,
  isContentType,
  parseTemplateId,
  templateOf,
  type ContentTemplate,
  type ContentType,
  type TemplateFormat,
} from "./content-templates";

export interface ProjectContentColumns {
  contentType?: string | null;
  contentTemplateId?: string | null;
  templateVersion?: string | null;
  contentSourceType?: string | null;
  audience?: string | null;
  tone?: string | null;
  voiceMode?: string | null;
  language?: string | null;
  scriptApprovedAt?: Date | null;
}

export interface ProjectContent {
  contentType: ContentType;
  template: ContentTemplate;
  format: TemplateFormat;
  templateVersion: string;
  sourceType: string;
  audience: string;
  tone: string;
  voiceMode: VoiceMode;
  language: string;
  /** Made before the engine existed (every content column NULL). */
  legacy: boolean;
}

export function projectContent(project: ProjectContentColumns): ProjectContent {
  const legacy = !project.contentType;
  const contentType: ContentType = isContentType(project.contentType) ? project.contentType : LEGACY_CONTENT_TYPE;
  const template = templateOf(contentType);
  const format = formatOf(template, parseTemplateId(project.contentTemplateId).formatId);
  return {
    contentType,
    template,
    format,
    templateVersion: project.templateVersion ?? template.promptVersion,
    sourceType: project.contentSourceType ?? (legacy ? "IDIOM" : "PROMPT"),
    audience: audienceOf(project.audience ?? template.defaultAudience).id,
    tone: toneOf(project.tone ?? template.defaultTone).id,
    voiceMode: (project.voiceMode as VoiceMode | null) ?? template.defaultVoiceMode,
    language: project.language ?? template.defaultLanguage,
    legacy,
  };
}

/**
 * Does media for this project wait for DUYỆT KỊCH BẢN?
 *
 * Only for a project the multi-content engine wrote. A legacy idiom project or
 * an imported storyboard never had that step and must not suddenly need it.
 */
export function needsScriptApproval(project: ProjectContentColumns): boolean {
  if (!project.contentType) return false;
  if (project.contentSourceType === "STORYBOARD" || project.contentSourceType === "IDIOM") return false;
  return !project.scriptApprovedAt;
}
