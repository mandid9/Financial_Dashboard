-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table: Categories
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  planned_amount NUMERIC(10, 2) DEFAULT 0.00,
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

-- Insert default 'Uncategorized' category
INSERT INTO categories (name, planned_amount) VALUES ('Uncategorized', 0);
