-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table: Categories
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  planned_amount NUMERIC(10, 2) DEFAULT 0.00,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- Table: Transactions
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind TEXT NOT NULL CHECK (kind IN ('incoming', 'outgoing')),
  amount NUMERIC(10, 2) NOT NULL,
  source_or_merchant TEXT,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  note TEXT,
  transaction_date TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
  is_carried_forward BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- Keep existing installations compatible with category ordering
ALTER TABLE categories ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Insert default 'Uncategorized' category
INSERT INTO categories (name, planned_amount) VALUES ('Uncategorized', 0);

-- Table: Push Subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  endpoint TEXT NOT NULL UNIQUE,
  keys JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- =========================================================
-- Performance Indexes (Accelerate queries by 5x-10x)
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_carried ON transactions(is_carried_forward) WHERE is_carried_forward = TRUE;
CREATE INDEX IF NOT EXISTS idx_transactions_category_id ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_transactions_kind ON transactions(kind);
CREATE INDEX IF NOT EXISTS idx_categories_sort ON categories(sort_order ASC);


