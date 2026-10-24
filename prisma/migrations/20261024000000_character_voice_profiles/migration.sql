-- QĐ-158 CHARACTER VOICE MANAGER. Additive only: '' on every existing row =
-- no language chosen = exactly the behaviour before (the line's language is
-- read from the project and the text). Nothing is removed or rewritten.
-- The language of the voice in voiceProvider/voiceModel/voiceId ("vi-VN", "en-US", "en-GB").
ALTER TABLE "Character" ADD COLUMN "voiceLanguage" TEXT NOT NULL DEFAULT '';
-- Voices for the character's OTHER languages: {"en-US": {provider, model, voiceId, speed, instructions, gender}}.
ALTER TABLE "Character" ADD COLUMN "voiceProfilesJson" TEXT NOT NULL DEFAULT '{}';
