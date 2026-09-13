import type { ProviderStatus } from "@/domain/enums";
import type { ScriptDoc, QualityReport, ScriptScore } from "@/domain/script";

/**
 * Provider contracts.
 *
 * Nothing outside `src/providers/**` may know which vendor is being used. UI and
 * services talk to these interfaces only, so adding Veo or swapping Runway for
 * Kling is a registry edit, not a refactor.
 */

export interface CostEstimate {
  amount: number;
  unit: string;
  detail: string;
}

export type ProviderJobState =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface ProviderJob {
  /** Vendor-side id. Stored so a retry can resume instead of paying twice. */
  externalId: string;
  state: ProviderJobState;
  provider: string;
  model: string;
  estimatedCost: number;
}

export interface JobStatus {
  externalId: string;
  state: ProviderJobState;
  progress: number;
  error?: string;
}

export interface GeneratedAsset {
  /** Absolute path on local disk. Always written by us, never by the vendor. */
  filePath: string;
  bytes: number;
  actualCost: number;
  generationTimeMs: number;
  meta?: Record<string, string | number | boolean>;
}

export interface BaseProvider {
  getName(): string;
  /** Reported to the admin page. Must not perform a paid call. */
  checkStatus(): Promise<ProviderStatus>;
}

// ------------------------------------------------------------------- text ---

export interface ScriptRequest {
  idiom: string;
  meaning: string;
  literalMeaning: string;
  exampleSentence: string;
  targetDuration: number;
  stylePrompt: string;
  characters: { name: string; personality: string; visualPrompt: string }[];
  /** Angles already used for this idiom, so the provider picks a new one. */
  avoidAngles: string[];
  model: string;
  /**
   * The fully rendered template from prompts/script.txt. Real providers send
   * this verbatim; the mock provider ignores it and uses its own templates.
   */
  systemPrompt: string;
}

export interface TextProvider extends BaseProvider {
  estimateScriptCost(req: ScriptRequest): Promise<CostEstimate>;
  generateScript(req: ScriptRequest): Promise<ScriptDoc>;
  scoreScript(script: ScriptDoc, model: string): Promise<ScriptScore>;
  generateYoutubeMeta(
    script: ScriptDoc,
    model: string,
  ): Promise<{
    title: string;
    description: string;
    hashtags: string[];
    keywords: string[];
  }>;
}

// ------------------------------------------------------------------ image ---

export interface ImageRequest {
  projectId: string;
  sceneId: string;
  model: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  seed?: number;
  referenceImages: string[];
  outputPath: string;
}

export interface ImageProvider extends BaseProvider {
  estimateCost(req: ImageRequest): Promise<CostEstimate>;
  createImage(req: ImageRequest): Promise<ProviderJob>;
  getJobStatus(externalId: string): Promise<JobStatus>;
  downloadResult(externalId: string): Promise<GeneratedAsset>;
  cancelJob?(externalId: string): Promise<void>;
}

// ------------------------------------------------------------------ video ---

export interface VideoRequest {
  projectId: string;
  sceneId: string;
  model: string;
  prompt: string;
  negativePrompt: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  seed?: number;
  /** Image-to-video keyframe, when the chosen model supports one. */
  referenceImagePath?: string;
  outputPath: string;
}

export interface VideoProvider extends BaseProvider {
  estimateCost(req: VideoRequest): Promise<CostEstimate>;
  createVideo(req: VideoRequest): Promise<ProviderJob>;
  getJobStatus(externalId: string): Promise<JobStatus>;
  downloadResult(externalId: string): Promise<GeneratedAsset>;
  cancelJob?(externalId: string): Promise<void>;
}

// ------------------------------------------------------------------ voice ---

export interface VoiceRequest {
  projectId: string;
  sceneId: string;
  model: string;
  text: string;
  voiceId: string;
  accent: "US" | "UK";
  gender: "male" | "female";
  speed: number;
  targetDuration: number;
  outputPath: string;
}

export interface VoiceProvider extends BaseProvider {
  estimateCost(req: VoiceRequest): Promise<CostEstimate>;
  createVoice(req: VoiceRequest): Promise<ProviderJob>;
  getJobStatus(externalId: string): Promise<JobStatus>;
  downloadResult(externalId: string): Promise<GeneratedAsset>;
  listVoices(): Promise<
    { id: string; label: string; accent: "US" | "UK"; gender: "male" | "female" }[]
  >;
}

// ---------------------------------------------------------------- upscale ---

export interface UpscaleRequest {
  projectId: string;
  sceneId: string;
  model: string;
  inputPath: string;
  outputPath: string;
  scale: 2 | 4;
}

export interface UpscaleProvider extends BaseProvider {
  estimateCost(req: UpscaleRequest): Promise<CostEstimate>;
  upscale(req: UpscaleRequest): Promise<GeneratedAsset>;
}

// ---------------------------------------------------------------- quality ---

export interface QualityRequest {
  projectId: string;
  sceneId: string;
  model: string;
  videoPath?: string;
  imagePath?: string;
  prompt: string;
  expectedCharacters: string[];
}

export interface QualityProvider extends BaseProvider {
  estimateCost(req: QualityRequest): Promise<CostEstimate>;
  evaluate(req: QualityRequest): Promise<QualityReport>;
}

export type AnyProvider =
  | TextProvider
  | ImageProvider
  | VideoProvider
  | VoiceProvider
  | UpscaleProvider
  | QualityProvider;

/** Thrown when a provider fails in a way the router may retry or fall back on. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean = true,
    readonly code: string = "provider_error",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
