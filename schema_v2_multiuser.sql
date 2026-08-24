-- =============================================================================
-- Financial Dashboard - Multi-User Architecture & Safe Migration (v2.0)
-- Target User: kr.wn20@gmail.com
-- =============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Add user_id column to existing tables (Non-destructive)
ALTER TABLE categories ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Create User Webhook Tokens table (For Android SMS Catch Service)
CREATE TABLE IF NOT EXISTS user_webhook_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- 3. Create User SMS Rules table (For Smart Customizable SMS Parsing)
CREATE TABLE IF NOT EXISTS user_sms_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  pattern_name TEXT NOT NULL,
  contains_keyword TEXT NOT NULL,
  merchant_extractor TEXT,
  default_category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- 4. Create Pending SMS Inbox table (Queue for untouched notifications after 5 min)
CREATE TABLE IF NOT EXISTS pending_sms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  raw_message TEXT NOT NULL,
  amount NUMERIC(10, 2),
  source_or_merchant TEXT,
  detected_kind TEXT DEFAULT 'outgoing',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'dismissed')),
  received_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- 5. Backfill existing records to your primary Google account (kr.wn20@gmail.com)
DO $$
DECLARE
  v_user_id UUID;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'kr.wn20@gmail.com' LIMIT 1;
  
  IF v_user_id IS NOT NULL THEN
    UPDATE categories SET user_id = v_user_id WHERE user_id IS NULL;
    UPDATE transactions SET user_id = v_user_id WHERE user_id IS NULL;
    UPDATE push_subscriptions SET user_id = v_user_id WHERE user_id IS NULL;
    
    INSERT INTO user_webhook_tokens (user_id) 
    VALUES (v_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
END $$;

-- 6. Trigger for Automatic Onboarding of NEW Users (General Category List)
CREATE OR REPLACE FUNCTION public.handle_new_user() 
RETURNS TRIGGER AS $$
BEGIN
  -- 1. Create a secure webhook token for the new user
  INSERT INTO public.user_webhook_tokens (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  -- 2. If the user is kr.wn20@gmail.com, backfill any unassigned data
  IF NEW.email = 'kr.wn20@gmail.com' THEN
    UPDATE public.categories SET user_id = NEW.id WHERE user_id IS NULL;
    UPDATE public.transactions SET user_id = NEW.id WHERE user_id IS NULL;
    UPDATE public.push_subscriptions SET user_id = NEW.id WHERE user_id IS NULL;
  ELSE
    -- 3. For any other NEW user, provision the clean general categories template
    INSERT INTO public.categories (user_id, name, planned_amount, sort_order) VALUES
      (NEW.id, 'Food & Dining', 0.00, 1),
      (NEW.id, 'Groceries & Supermarket', 0.00, 2),
      (NEW.id, 'Transportation & Fuel', 0.00, 3),
      (NEW.id, 'Bills & Utilities', 0.00, 4),
      (NEW.id, 'Housing & Rent', 0.00, 5),
      (NEW.id, 'Shopping & Personal', 0.00, 6),
      (NEW.id, 'Health & Medical', 0.00, 7),
      (NEW.id, 'Debt & Credit Card', 0.00, 8),
      (NEW.id, 'Savings & Investments', 0.00, 9),
      (NEW.id, 'Uncategorized', 0.00, 10)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Bind trigger to auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 7. Multi-User Performance Indexes
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_categories_user_id ON categories(user_id);
CREATE INDEX IF NOT EXISTS idx_push_user_id ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_sms_user ON pending_sms(user_id, status);
CREATE INDEX IF NOT EXISTS idx_webhook_token ON user_webhook_tokens(token);

-- 8. Row Level Security (RLS) Policies
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sms_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_sms ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_webhook_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "User categories policy" ON categories;
CREATE POLICY "User categories policy" ON categories
  FOR ALL USING (auth.uid() = user_id OR user_id IS NULL);

DROP POLICY IF EXISTS "User transactions policy" ON transactions;
CREATE POLICY "User transactions policy" ON transactions
  FOR ALL USING (auth.uid() = user_id OR user_id IS NULL);

DROP POLICY IF EXISTS "User push policy" ON push_subscriptions;
CREATE POLICY "User push policy" ON push_subscriptions
  FOR ALL USING (auth.uid() = user_id OR user_id IS NULL);

DROP POLICY IF EXISTS "User sms rules policy" ON user_sms_rules;
CREATE POLICY "User sms rules policy" ON user_sms_rules
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "User pending sms policy" ON pending_sms;
CREATE POLICY "User pending sms policy" ON pending_sms
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "User webhook tokens policy" ON user_webhook_tokens;
CREATE POLICY "User webhook tokens policy" ON user_webhook_tokens
  FOR ALL USING (auth.uid() = user_id);
