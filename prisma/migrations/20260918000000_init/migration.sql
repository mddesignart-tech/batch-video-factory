-- CreateTable
CREATE TABLE "Idiom" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phrase" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "meaning" TEXT NOT NULL,
    "literalMeaning" TEXT NOT NULL,
    "exampleSentence" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL DEFAULT 'Beginner',
    "region" TEXT NOT NULL DEFAULT 'General',
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'unused',
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "personality" TEXT NOT NULL,
    "visualPrompt" TEXT NOT NULL,
    "negativePrompt" TEXT NOT NULL DEFAULT '',
    "facialFeatures" TEXT NOT NULL DEFAULT '',
    "hair" TEXT NOT NULL DEFAULT '',
    "outfit" TEXT NOT NULL DEFAULT '',
    "bodyProportions" TEXT NOT NULL DEFAULT '',
    "accessories" TEXT NOT NULL DEFAULT '',
    "colorPalette" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "stylePresetId" TEXT,
    "voiceProvider" TEXT NOT NULL DEFAULT 'mock',
    "voiceModel" TEXT NOT NULL DEFAULT 'mock-voice-std',
    "voiceId" TEXT NOT NULL DEFAULT 'mock-male-us',
    "voiceInstructions" TEXT NOT NULL DEFAULT '',
    "voiceSpeed" REAL NOT NULL DEFAULT 1,
    "voiceGender" TEXT NOT NULL DEFAULT 'male',
    "voiceAccent" TEXT NOT NULL DEFAULT 'US',
    "seed" INTEGER,
    "notes" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DialogueLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sceneId" TEXT NOT NULL,
    "characterId" TEXT,
    "lineNumber" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "voiceId" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL DEFAULT '',
    "speed" REAL NOT NULL DEFAULT 1,
    "pauseAfterMs" INTEGER,
    "estimatedCost" REAL NOT NULL DEFAULT 0,
    "actualCost" REAL NOT NULL DEFAULT 0,
    "durationSec" REAL NOT NULL DEFAULT 0,
    "outputPath" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DialogueLine_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "Scene" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DialogueLine_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CharacterReference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "characterId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "prompt" TEXT NOT NULL DEFAULT '',
    "characterVersion" INTEGER NOT NULL DEFAULT 1,
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CharacterReference_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StylePreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "positivePrompt" TEXT NOT NULL,
    "negativePrompt" TEXT NOT NULL,
    "lightingStyle" TEXT NOT NULL,
    "cameraLanguage" TEXT NOT NULL,
    "visualTone" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL DEFAULT '9:16',
    "preferredModels" TEXT NOT NULL DEFAULT '[]',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ModelRegistry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priceUnit" TEXT NOT NULL,
    "price" REAL NOT NULL DEFAULT 0,
    "priceOutput" REAL NOT NULL DEFAULT 0,
    "supportsTextToVideo" BOOLEAN NOT NULL DEFAULT false,
    "supportsImageToVideo" BOOLEAN NOT NULL DEFAULT false,
    "supportsReferenceImage" BOOLEAN NOT NULL DEFAULT false,
    "supportsCharacterReference" BOOLEAN NOT NULL DEFAULT false,
    "supportsInputFidelity" BOOLEAN NOT NULL DEFAULT false,
    "supportsAudio" BOOLEAN NOT NULL DEFAULT false,
    "supports1080p" BOOLEAN NOT NULL DEFAULT false,
    "supportsUpscale" BOOLEAN NOT NULL DEFAULT false,
    "supportsVoiceInstructions" BOOLEAN NOT NULL DEFAULT false,
    "maxDuration" INTEGER NOT NULL DEFAULT 0,
    "qualityRating" INTEGER NOT NULL DEFAULT 5,
    "speedRating" INTEGER NOT NULL DEFAULT 5,
    "consistencyRating" INTEGER NOT NULL DEFAULT 5,
    "historicalSuccessRate" REAL NOT NULL DEFAULT 1,
    "lifecycle" TEXT NOT NULL DEFAULT 'ACTIVE',
    "providerModelKey" TEXT,
    "verification" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verificationNote" TEXT NOT NULL DEFAULT '',
    "verifiedAt" DATETIME,
    "existenceSource" TEXT NOT NULL DEFAULT 'MANUAL_DOCS',
    "existenceCheckedAt" DATETIME,
    "pricingSource" TEXT NOT NULL DEFAULT 'MANUAL_DOCS',
    "pricingCheckedAt" DATETIME,
    "capabilitySource" TEXT NOT NULL DEFAULT 'MANUAL_DOCS',
    "sourceNote" TEXT NOT NULL DEFAULT '',
    "maxConcurrent" INTEGER,
    "maxDaily" INTEGER,
    "reliability" TEXT NOT NULL DEFAULT 'OK',
    "reliabilityNote" TEXT NOT NULL DEFAULT '',
    "reliabilityUpdatedAt" DATETIME,
    "deprecationDate" DATETIME,
    "shutdownDate" DATETIME,
    "replacementNote" TEXT NOT NULL DEFAULT '',
    "lastVerifiedAt" DATETIME,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProviderConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "types" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "apiKeyEnc" TEXT,
    "apiKeyMask" TEXT,
    "apiKeyEnvVar" TEXT NOT NULL DEFAULT '',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "fallbackPriority" INTEGER NOT NULL DEFAULT 100,
    "status" TEXT NOT NULL DEFAULT 'disabled',
    "lastCheckedAt" DATETIME,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "idiomId" TEXT NOT NULL,
    "batchId" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "qualityMode" TEXT NOT NULL DEFAULT 'BALANCED',
    "routerStrategy" TEXT NOT NULL DEFAULT 'AUTO',
    "stylePresetId" TEXT,
    "targetDuration" INTEGER NOT NULL DEFAULT 25,
    "aspectRatio" TEXT NOT NULL DEFAULT '9:16',
    "language" TEXT NOT NULL DEFAULT 'en',
    "scriptJson" TEXT,
    "scriptHash" TEXT,
    "angleKey" TEXT,
    "scriptScoreJson" TEXT,
    "youtubeMetaJson" TEXT,
    "estimatedCost" REAL NOT NULL DEFAULT 0,
    "actualCost" REAL NOT NULL DEFAULT 0,
    "maxBudget" REAL NOT NULL DEFAULT 10,
    "finalVideoPath" TEXT,
    "subtitlePath" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_idiomId_fkey" FOREIGN KEY ("idiomId") REFERENCES "Idiom" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Project_stylePresetId_fkey" FOREIGN KEY ("stylePresetId") REFERENCES "StylePreset" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Project_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Scene" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sceneNumber" INTEGER NOT NULL,
    "duration" REAL NOT NULL DEFAULT 4,
    "visualDescription" TEXT NOT NULL DEFAULT '',
    "dialogue" TEXT NOT NULL DEFAULT '',
    "narration" TEXT NOT NULL DEFAULT '',
    "subtitle" TEXT NOT NULL DEFAULT '',
    "camera" TEXT NOT NULL DEFAULT '',
    "characterAction" TEXT NOT NULL DEFAULT '',
    "soundEffect" TEXT NOT NULL DEFAULT '',
    "imagePrompt" TEXT NOT NULL DEFAULT '',
    "videoPrompt" TEXT NOT NULL DEFAULT '',
    "complexity" TEXT NOT NULL DEFAULT 'LOW',
    "spendPriority" TEXT NOT NULL DEFAULT 'NORMAL',
    "charactersPresentJson" TEXT NOT NULL DEFAULT '[]',
    "speakingCharactersJson" TEXT NOT NULL DEFAULT '[]',
    "primaryCharactersJson" TEXT NOT NULL DEFAULT '[]',
    "routingMode" TEXT NOT NULL DEFAULT 'AUTO',
    "motionSource" TEXT NOT NULL DEFAULT 'AI_VIDEO',
    "motionMode" TEXT NOT NULL DEFAULT 'AUTO',
    "imageSource" TEXT NOT NULL DEFAULT 'GENERATED',
    "imageProvider" TEXT,
    "imageModel" TEXT,
    "videoProvider" TEXT,
    "videoModel" TEXT,
    "voiceProvider" TEXT,
    "voiceModel" TEXT,
    "estimatedCost" REAL NOT NULL DEFAULT 0,
    "actualCost" REAL NOT NULL DEFAULT 0,
    "imagePath" TEXT,
    "videoPath" TEXT,
    "audioPath" TEXT,
    "qualityScore" REAL,
    "qualityJson" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "providerFlagsJson" TEXT NOT NULL DEFAULT '[]',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Scene_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sceneId" TEXT,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL DEFAULT '',
    "negativePrompt" TEXT NOT NULL DEFAULT '',
    "seed" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "generationTimeMs" INTEGER NOT NULL DEFAULT 0,
    "estimatedCost" REAL NOT NULL DEFAULT 0,
    "actualCost" REAL NOT NULL DEFAULT 0,
    "filePath" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Asset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Asset_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "Scene" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 5,
    "category" TEXT,
    "difficulty" TEXT,
    "stylePresetId" TEXT,
    "qualityMode" TEXT NOT NULL DEFAULT 'BALANCED',
    "targetDuration" INTEGER NOT NULL DEFAULT 25,
    "voiceProvider" TEXT NOT NULL DEFAULT 'mock',
    "voiceId" TEXT NOT NULL DEFAULT 'mock-male-us',
    "maxBudget" REAL NOT NULL DEFAULT 40,
    "concurrency" INTEGER NOT NULL DEFAULT 2,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "estimatedCost" REAL NOT NULL DEFAULT 0,
    "actualCost" REAL NOT NULL DEFAULT 0,
    "maxCostPerVideo" REAL NOT NULL DEFAULT 2.5,
    "planJson" TEXT NOT NULL DEFAULT '{}',
    "idiomIdsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BatchAuthorization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "estimatedCost" REAL NOT NULL DEFAULT 0,
    "authorizedMaxSpend" REAL NOT NULL DEFAULT 0,
    "maxCostPerVideo" REAL NOT NULL DEFAULT 2.5,
    "actualSpend" REAL NOT NULL DEFAULT 0,
    "providerScopeJson" TEXT NOT NULL DEFAULT '[]',
    "videoCount" INTEGER NOT NULL DEFAULT 0,
    "qualityMode" TEXT NOT NULL DEFAULT 'BALANCED',
    "lowAutoApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" DATETIME,
    "closedReason" TEXT NOT NULL DEFAULT '',
    "closedAt" DATETIME,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BatchAuthorization_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CostReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "projectId" TEXT,
    "sceneId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "estimatedCost" REAL NOT NULL DEFAULT 0,
    "actualCost" REAL NOT NULL DEFAULT 0,
    "possiblyBilled" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "settledAt" DATETIME,
    CONSTRAINT "CostReservation_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextRunAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "error" TEXT,
    "resultJson" TEXT,
    "projectId" TEXT,
    "batchId" TEXT,
    "sceneId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Job_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Job_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProviderJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "previousExternalIds" TEXT NOT NULL DEFAULT '[]',
    "externalId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestJson" TEXT NOT NULL DEFAULT '{}',
    "responseJson" TEXT,
    "error" TEXT,
    "failureCode" TEXT,
    "billedUnits" REAL,
    "projectId" TEXT,
    "sceneId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "durationMs" INTEGER,
    "estimatedCost" REAL NOT NULL DEFAULT 0,
    "actualCost" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "CostEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "batchId" TEXT,
    "sceneId" TEXT,
    "category" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "isRetry" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CostEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LogEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" TEXT NOT NULL DEFAULT 'info',
    "event" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "provider" TEXT,
    "model" TEXT,
    "projectId" TEXT,
    "sceneId" TEXT,
    "jobId" TEXT,
    "durationMs" INTEGER,
    "estimatedCost" REAL,
    "actualCost" REAL,
    "status" TEXT,
    "dataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ConceptHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "idiomId" TEXT NOT NULL,
    "projectId" TEXT,
    "angleKey" TEXT NOT NULL,
    "scriptHash" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "VideoBenchmark" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "taskId" TEXT,
    "projectId" TEXT,
    "sceneNumber" INTEGER NOT NULL,
    "complexity" TEXT NOT NULL,
    "complexityScore" REAL NOT NULL DEFAULT 0,
    "characterCount" INTEGER NOT NULL DEFAULT 0,
    "promptSent" TEXT NOT NULL DEFAULT '',
    "durationRequested" REAL NOT NULL DEFAULT 0,
    "durationSent" REAL NOT NULL DEFAULT 0,
    "keyframePath" TEXT NOT NULL DEFAULT '',
    "outcome" TEXT NOT NULL,
    "failureCode" TEXT NOT NULL DEFAULT '',
    "credits" INTEGER NOT NULL DEFAULT 0,
    "actualCost" REAL NOT NULL DEFAULT 0,
    "generationMs" INTEGER NOT NULL DEFAULT 0,
    "outputPath" TEXT NOT NULL DEFAULT '',
    "scoresJson" TEXT NOT NULL DEFAULT '{}',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ModelFailureEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "failureCode" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "projectId" TEXT,
    "sceneId" TEXT,
    "taskId" TEXT,
    "billedUnits" REAL,
    "actualCost" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ProviderCatalogSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "modelKeysJson" TEXT NOT NULL DEFAULT '[]',
    "endpoint" TEXT NOT NULL DEFAULT '',
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "valueJson" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Idiom_slug_key" ON "Idiom"("slug");

-- CreateIndex
CREATE INDEX "Idiom_status_idx" ON "Idiom"("status");

-- CreateIndex
CREATE INDEX "Idiom_category_idx" ON "Idiom"("category");

-- CreateIndex
CREATE INDEX "Idiom_difficulty_idx" ON "Idiom"("difficulty");

-- CreateIndex
CREATE UNIQUE INDEX "Character_name_key" ON "Character"("name");

-- CreateIndex
CREATE INDEX "Character_enabled_idx" ON "Character"("enabled");

-- CreateIndex
CREATE INDEX "DialogueLine_sceneId_idx" ON "DialogueLine"("sceneId");

-- CreateIndex
CREATE INDEX "DialogueLine_characterId_idx" ON "DialogueLine"("characterId");

-- CreateIndex
CREATE INDEX "DialogueLine_status_idx" ON "DialogueLine"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DialogueLine_sceneId_lineNumber_key" ON "DialogueLine"("sceneId", "lineNumber");

-- CreateIndex
CREATE INDEX "CharacterReference_characterId_isPrimary_idx" ON "CharacterReference"("characterId", "isPrimary");

-- CreateIndex
CREATE UNIQUE INDEX "StylePreset_name_key" ON "StylePreset"("name");

-- CreateIndex
CREATE UNIQUE INDEX "StylePreset_slug_key" ON "StylePreset"("slug");

-- CreateIndex
CREATE INDEX "ModelRegistry_type_enabled_idx" ON "ModelRegistry"("type", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRegistry_provider_modelId_key" ON "ModelRegistry"("provider", "modelId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConfig_name_key" ON "ProviderConfig"("name");

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status");

-- CreateIndex
CREATE INDEX "Project_createdAt_idx" ON "Project"("createdAt");

-- CreateIndex
CREATE INDEX "Project_batchId_idx" ON "Project"("batchId");

-- CreateIndex
CREATE INDEX "Scene_status_idx" ON "Scene"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Scene_projectId_sceneNumber_key" ON "Scene"("projectId", "sceneNumber");

-- CreateIndex
CREATE INDEX "Asset_projectId_kind_idx" ON "Asset"("projectId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "BatchAuthorization_batchId_key" ON "BatchAuthorization"("batchId");

-- CreateIndex
CREATE INDEX "BatchAuthorization_status_idx" ON "BatchAuthorization"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CostReservation_idempotencyKey_key" ON "CostReservation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CostReservation_batchId_status_idx" ON "CostReservation"("batchId", "status");

-- CreateIndex
CREATE INDEX "CostReservation_projectId_idx" ON "CostReservation"("projectId");

-- CreateIndex
CREATE INDEX "Job_status_nextRunAt_idx" ON "Job"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "Job_projectId_idx" ON "Job"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderJob_idempotencyKey_key" ON "ProviderJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ProviderJob_status_idx" ON "ProviderJob"("status");

-- CreateIndex
CREATE INDEX "ProviderJob_sceneId_kind_idx" ON "ProviderJob"("sceneId", "kind");

-- CreateIndex
CREATE INDEX "CostEntry_createdAt_idx" ON "CostEntry"("createdAt");

-- CreateIndex
CREATE INDEX "CostEntry_category_idx" ON "CostEntry"("category");

-- CreateIndex
CREATE INDEX "LogEntry_createdAt_idx" ON "LogEntry"("createdAt");

-- CreateIndex
CREATE INDEX "LogEntry_level_idx" ON "LogEntry"("level");

-- CreateIndex
CREATE INDEX "ConceptHistory_idiomId_idx" ON "ConceptHistory"("idiomId");

-- CreateIndex
CREATE INDEX "ConceptHistory_scriptHash_idx" ON "ConceptHistory"("scriptHash");

-- CreateIndex
CREATE INDEX "VideoBenchmark_provider_model_idx" ON "VideoBenchmark"("provider", "model");

-- CreateIndex
CREATE INDEX "VideoBenchmark_sceneNumber_idx" ON "VideoBenchmark"("sceneNumber");

-- CreateIndex
CREATE INDEX "VideoBenchmark_outcome_idx" ON "VideoBenchmark"("outcome");

-- CreateIndex
CREATE INDEX "ModelFailureEvidence_provider_model_idx" ON "ModelFailureEvidence"("provider", "model");

-- CreateIndex
CREATE INDEX "ModelFailureEvidence_failureCode_idx" ON "ModelFailureEvidence"("failureCode");

-- CreateIndex
CREATE INDEX "ModelFailureEvidence_sceneId_idx" ON "ModelFailureEvidence"("sceneId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelFailureEvidence_model_fingerprint_key" ON "ModelFailureEvidence"("model", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCatalogSnapshot_provider_key" ON "ProviderCatalogSnapshot"("provider");

-- CreateIndex
CREATE INDEX "ProviderCatalogSnapshot_provider_idx" ON "ProviderCatalogSnapshot"("provider");

