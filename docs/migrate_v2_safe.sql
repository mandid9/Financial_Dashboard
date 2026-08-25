-- =============================================================================
-- Financial Dashboard — v2 Multi-User Migration (SAFE VERSION)
-- Run in: Supabase Studio -> SQL Editor -> New query (paste EVERYTHING)
-- Idempotent: safe to run multiple times.
--
-- NOTE: RLS policies are intentionally NOT included here.
-- The server currently uses the anon-key client; enabling the v2 RLS block
-- would hide all backfilled rows (auth.uid() is null server-side) and blank
-- the dashboard. Enable RLS only after switching to per-request authenticated
-- clients (see Alpha.md, Phase 1).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Add user_id columns -------------------------------------------------------
ALTER TABLE public.categories         ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.transactions       ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Webhook tokens (SMS ingest + daily cron) ----------------------------------
CREATE TABLE IF NOT EXISTS public.user_webhook_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  token      TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

-- 3. Custom SMS rules + pending inbox -------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_sms_rules (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  pattern_name        TEXT NOT NULL,
  contains_keyword    TEXT NOT NULL,
  merchant_extractor  TEXT,
  default_category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
  is_active           BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.pending_sms (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  raw_message        TEXT NOT NULL,
  amount             NUMERIC(10,2),
  source_or_merchant TEXT,
  detected_kind      TEXT DEFAULT 'outgoing',
  status             TEXT DEFAULT 'pending' CHECK (status IN ('pending','confirmed','dismissed')),
  idempotency_key    TEXT,
  received_at        TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

-- 4. Assign all existing data to your account -----------------------------------
DO $$
DECLARE
  v_user UUID;
BEGIN
  SELECT id INTO v_user FROM auth.users WHERE email = 'kr.wn20@gmail.com' LIMIT 1;
  IF v_user IS NOT NULL THEN
    UPDATE public.categories         SET user_id = v_user WHERE user_id IS NULL;
    UPDATE public.transactions       SET user_id = v_user WHERE user_id IS NULL;
    UPDATE public.push_subscriptions SET user_id = v_user WHERE user_id IS NULL;
    INSERT INTO public.user_webhook_tokens (user_id)
    VALUES (v_user)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
END $$;

-- 5. Auto-provision future signups ------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_webhook_tokens (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  IF NEW.email <> 'kr.wn20@gmail.com' THEN
    INSERT INTO public.categories (user_id, name, planned_amount, sort_order) VALUES
      (NEW.id, 'Food & Dining',            0.00, 1),
      (NEW.id, 'Groceries & Supermarket',  0.00, 2),
      (NEW.id, 'Transportation & Fuel',    0.00, 3),
      (NEW.id, 'Bills & Utilities',        0.00, 4),
      (NEW.id, 'Housing & Rent',           0.00, 5),
      (NEW.id, 'Shopping & Personal',      0.00, 6),
      (NEW.id, 'Health & Medical',         0.00, 7),
      (NEW.id, 'Debt & Credit Card',       0.00, 8),
      (NEW.id, 'Savings & Investments',    0.00, 9),
      (NEW.id, 'Uncategorized',            0.00, 10);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 6. Indexes ------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON public.transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_categories_user_id   ON public.categories(user_id);
CREATE INDEX IF NOT EXISTS idx_push_user_id         ON public.push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_sms_user     ON public.pending_sms(user_id, status);
CREATE INDEX IF NOT EXISTS idx_webhook_token        ON public.user_webhook_tokens(token);

-- 7. Verification (results should appear in the output) ------------------------------
SELECT relname AS table_name, relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND relname IN ('categories','transactions','push_subscriptions',
                  'user_webhook_tokens','user_sms_rules','pending_sms');

SELECT count(*) AS your_backfilled_categories FROM public.categories WHERE user_id IS NOT NULL;
SELECT count(*) AS your_backfilled_transactions FROM public.transactions WHERE user_id IS NOT NULL;

ALTER TABLE public.pending_sms ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_sms_idempotency ON public.pending_sms(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;


-- SMS rule v2 fields: sender/content/action are explicit and independently editable.
ALTER TABLE public.user_sms_rules ADD COLUMN IF NOT EXISTS sender_pattern TEXT;
ALTER TABLE public.user_sms_rules ADD COLUMN IF NOT EXISTS content_pattern TEXT;
ALTER TABLE public.user_sms_rules ADD COLUMN IF NOT EXISTS match_type TEXT DEFAULT 'contains';
ALTER TABLE public.user_sms_rules ADD COLUMN IF NOT EXISTS direction TEXT DEFAULT 'auto';
ALTER TABLE public.user_sms_rules ADD COLUMN IF NOT EXISTS catch_mode TEXT DEFAULT 'catch';
ALTER TABLE public.user_sms_rules ADD COLUMN IF NOT EXISTS amount_pattern TEXT;
ALTER TABLE public.user_sms_rules ADD COLUMN IF NOT EXISTS merchant_pattern TEXT;
ALTER TABLE public.user_sms_rules ADD COLUMN IF NOT EXISTS confirmation_mode TEXT DEFAULT 'confirm';
ALTER TABLE public.user_sms_rules ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 100;
ALTER TABLE public.user_sms_rules ADD COLUMN IF NOT EXISTS match_count INTEGER DEFAULT 0;
ALTER TABLE public.user_sms_rules ADD COLUMN IF NOT EXISTS last_matched_at TIMESTAMPTZ;
ALTER TABLE public.user_sms_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now());
UPDATE public.user_sms_rules SET content_pattern = contains_keyword WHERE content_pattern IS NULL;
UPDATE public.user_sms_rules SET sender_pattern = contains_keyword WHERE sender_pattern IS NULL AND content_pattern IS NULL;
