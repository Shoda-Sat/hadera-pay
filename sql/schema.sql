-- HaderaPay immutable double-entry ledger schema.
-- Monetary values are always integer minor units: cents, satoshis, fils, etc.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE actor_role AS ENUM ('MASTER', 'BROKER', 'AGENT', 'SPECIAL_BROKER');
CREATE TYPE ledger_account_kind AS ENUM (
  'ACTOR_CLEARING',
  'MASTER_CASH',
  'MASTER_FX_CLEARING',
  'MASTER_FEE_REVENUE'
);
CREATE TYPE order_state AS ENUM (
  'DRAFT',
  'PENDING_FORWARD',
  'ASSIGNED',
  'PAID',
  'CANCELLED',
  'VOIDED'
);
CREATE TYPE transfer_state AS ENUM (
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'PENDING_RECEIVE',
  'RECEIVED'
);
CREATE TYPE ledger_direction AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE journal_source_type AS ENUM ('ORDER_PAYMENT', 'ORDER_VOID', 'TRANSFER', 'TRANSFER_REVERSAL', 'SETTLEMENT');
CREATE TYPE transfer_type AS ENUM (
  'MASTER_TO_ACTOR',
  'AGENT_TO_AGENT',
  'BROKER_TO_MASTER',
  'MASTER_TOP_UP'
);
CREATE TYPE settlement_direction AS ENUM ('ACTOR_PAID_MASTER', 'MASTER_PAID_ACTOR');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  role actor_role NOT NULL,
  base_currency char(3) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id),
  kind ledger_account_kind NOT NULL,
  currency char(3) NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actor_accounts_have_owner CHECK (
    (kind = 'ACTOR_CLEARING' AND owner_user_id IS NOT NULL)
    OR (kind <> 'ACTOR_CLEARING' AND owner_user_id IS NULL)
  ),
  CONSTRAINT one_actor_account_per_currency UNIQUE (owner_user_id, currency, kind),
  CONSTRAINT one_platform_account_per_currency UNIQUE (kind, currency)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_user_id uuid NOT NULL REFERENCES users(id),
  assigned_agent_user_id uuid REFERENCES users(id),
  state order_state NOT NULL DEFAULT 'DRAFT',
  source_currency char(3) NOT NULL,
  payout_currency char(3) NOT NULL,
  source_amount_minor bigint NOT NULL CHECK (source_amount_minor > 0),
  payout_amount_minor bigint NOT NULL CHECK (payout_amount_minor > 0),
  exchange_rate_numerator bigint NOT NULL CHECK (exchange_rate_numerator > 0),
  exchange_rate_denominator bigint NOT NULL CHECK (exchange_rate_denominator > 0),
  commission_bps integer NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 10000),
  commission_amount_minor bigint NOT NULL DEFAULT 0 CHECK (commission_amount_minor >= 0),
  sender_name text,
  receiver_name text,
  receiver_account_number text,
  receiver_phone_number text,
  remarks text,
  paid_journal_entry_id uuid,
  void_journal_entry_id uuid,
  voidable_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_receiver_detail_required CHECK (
    nullif(trim(coalesce(receiver_name, '')), '') IS NOT NULL
    OR nullif(trim(coalesce(receiver_account_number, '')), '') IS NOT NULL
    OR nullif(trim(coalesce(receiver_phone_number, '')), '') IS NOT NULL
    OR nullif(trim(coalesce(remarks, '')), '') IS NOT NULL
  ),
  CONSTRAINT assigned_orders_have_agent CHECK (
    state NOT IN ('ASSIGNED', 'PAID', 'VOIDED') OR assigned_agent_user_id IS NOT NULL
  )
);

CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_type transfer_type NOT NULL,
  initiated_by_user_id uuid NOT NULL REFERENCES users(id),
  from_user_id uuid REFERENCES users(id),
  to_user_id uuid REFERENCES users(id),
  state transfer_state NOT NULL DEFAULT 'PENDING_APPROVAL',
  source_currency char(3) NOT NULL,
  destination_currency char(3) NOT NULL,
  source_amount_minor bigint NOT NULL CHECK (source_amount_minor > 0),
  destination_amount_minor bigint NOT NULL CHECK (destination_amount_minor > 0),
  exchange_rate_numerator bigint NOT NULL CHECK (exchange_rate_numerator > 0),
  exchange_rate_denominator bigint NOT NULL CHECK (exchange_rate_denominator > 0),
  commission_bps integer NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 10000),
  commission_amount_minor bigint NOT NULL DEFAULT 0 CHECK (commission_amount_minor >= 0),
  approved_by_user_id uuid REFERENCES users(id),
  received_by_user_id uuid REFERENCES users(id),
  journal_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type journal_source_type NOT NULL,
  source_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  description text NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  reversed_journal_entry_id uuid REFERENCES journal_entries(id),
  created_by_user_id uuid REFERENCES users(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE ledger_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  direction ledger_direction NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  memo text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_run_id text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  currency char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  direction settlement_direction NOT NULL,
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_settlement_per_actor_currency_run UNIQUE (settlement_run_id, actor_user_id, currency)
);

ALTER TABLE orders
  ADD CONSTRAINT orders_paid_journal_entry_fk
  FOREIGN KEY (paid_journal_entry_id) REFERENCES journal_entries(id),
  ADD CONSTRAINT orders_void_journal_entry_fk
  FOREIGN KEY (void_journal_entry_id) REFERENCES journal_entries(id);

ALTER TABLE transfers
  ADD CONSTRAINT transfers_journal_entry_fk
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id);

CREATE INDEX ledger_lines_account_currency_idx ON ledger_lines (account_id, currency, created_at);
CREATE INDEX journal_entries_source_idx ON journal_entries (source_type, source_id);

CREATE VIEW account_balances AS
SELECT
  account_id,
  currency,
  sum(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END)::bigint AS debit_minus_credit_minor
FROM ledger_lines
GROUP BY account_id, currency;

CREATE OR REPLACE FUNCTION assert_ledger_line_currency_matches_account()
RETURNS trigger AS $$
DECLARE account_currency char(3);
BEGIN
  SELECT currency INTO account_currency FROM ledger_accounts WHERE id = NEW.account_id;
  IF account_currency <> NEW.currency THEN
    RAISE EXCEPTION 'ledger line currency % does not match account currency %', NEW.currency, account_currency;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_line_currency_matches_account
BEFORE INSERT ON ledger_lines
FOR EACH ROW EXECUTE FUNCTION assert_ledger_line_currency_matches_account();

CREATE OR REPLACE FUNCTION assert_journal_balanced()
RETURNS trigger AS $$
DECLARE bad_currency char(3);
BEGIN
  SELECT currency INTO bad_currency
  FROM ledger_lines
  WHERE journal_entry_id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id)
  GROUP BY currency
  HAVING sum(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0
  LIMIT 1;

  IF bad_currency IS NOT NULL THEN
    RAISE EXCEPTION 'journal entry % is not balanced for currency %',
      COALESCE(NEW.journal_entry_id, OLD.journal_entry_id), bad_currency;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_must_balance
AFTER INSERT ON ledger_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

CREATE OR REPLACE FUNCTION assert_journal_has_lines()
RETURNS trigger AS $$
DECLARE line_count integer;
BEGIN
  SELECT count(*) INTO line_count FROM ledger_lines WHERE journal_entry_id = NEW.id;
  IF line_count < 2 THEN
    RAISE EXCEPTION 'journal entry % must have at least two ledger lines', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_must_have_lines
AFTER INSERT ON journal_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_journal_has_lines();

CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger records are immutable; post a reversing journal entry instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_lines_no_update_delete
BEFORE UPDATE OR DELETE ON ledger_lines
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER journal_entries_no_update_delete
BEFORE UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
