-- DeskOS schema: first-class Twilio adapter configuration.
-- Secrets remain in provider_secret_enc; account/from/TwiML metadata is not secret.
ALTER TABLE telephony_integrations
  ADD COLUMN IF NOT EXISTS provider_config jsonb NOT NULL DEFAULT '{}'::jsonb;
