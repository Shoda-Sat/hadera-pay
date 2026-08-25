ALTER TABLE hp_actors DROP CONSTRAINT IF EXISTS hp_actors_ordinal_check;
ALTER TABLE hp_orders DROP CONSTRAINT IF EXISTS hp_orders_ordinal_check;
ALTER TABLE hp_receivables DROP CONSTRAINT IF EXISTS hp_receivables_ordinal_check;
ALTER TABLE hp_transfers DROP CONSTRAINT IF EXISTS hp_transfers_ordinal_check;
ALTER TABLE hp_ledger_lines DROP CONSTRAINT IF EXISTS hp_ledger_lines_ordinal_check;
ALTER TABLE hp_saved_customers DROP CONSTRAINT IF EXISTS hp_saved_customers_ordinal_check;
ALTER TABLE hp_master_bank_entries DROP CONSTRAINT IF EXISTS hp_master_bank_entries_ordinal_check;
ALTER TABLE hp_settlements DROP CONSTRAINT IF EXISTS hp_settlements_ordinal_check;
ALTER TABLE hp_journal_entries DROP CONSTRAINT IF EXISTS hp_journal_entries_first_ordinal_check;

COMMENT ON COLUMN hp_orders.ordinal IS
  'Stable display order. Runtime prepends use decreasing values so existing orders are not rewritten.';
COMMENT ON COLUMN hp_ledger_lines.ordinal IS
  'Stable display order. Runtime prepends use decreasing values so existing ledger lines are not rewritten.';

CREATE TABLE hp_chat_conversations (
  workspace_id text NOT NULL REFERENCES hp_workspace_states(workspace_id) ON DELETE RESTRICT,
  record_key text NOT NULL,
  legacy_id text,
  ordinal integer NOT NULL,
  chat_type text,
  updated_at_text text,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  PRIMARY KEY (workspace_id, record_key),
  UNIQUE (workspace_id, ordinal)
);

CREATE INDEX hp_chat_conversations_legacy_id_idx
  ON hp_chat_conversations(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

CREATE TABLE hp_chat_messages (
  workspace_id text NOT NULL,
  conversation_record_key text NOT NULL,
  record_key text NOT NULL,
  legacy_id text,
  ordinal integer NOT NULL,
  order_id text,
  created_at_text text,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  PRIMARY KEY (workspace_id, record_key),
  UNIQUE (workspace_id, ordinal),
  FOREIGN KEY (workspace_id, conversation_record_key)
    REFERENCES hp_chat_conversations(workspace_id, record_key)
    ON DELETE RESTRICT
);

CREATE INDEX hp_chat_messages_conversation_idx
  ON hp_chat_messages(workspace_id, conversation_record_key, ordinal);
CREATE INDEX hp_chat_messages_order_idx
  ON hp_chat_messages(workspace_id, order_id, created_at_text);
CREATE INDEX hp_chat_messages_legacy_id_idx
  ON hp_chat_messages(workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

WITH chats AS (
  SELECT
    state.workspace_id,
    chat.value AS payload,
    (chat.ordinality - 1)::integer AS ordinal,
    'chat:migrated:' || lpad((chat.ordinality - 1)::text, 8, '0') AS record_key
  FROM hp_workspace_states AS state
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(state.settings -> 'chatConversations') = 'array'
      THEN state.settings -> 'chatConversations'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS chat(value, ordinality)
)
INSERT INTO hp_chat_conversations(
  workspace_id, record_key, legacy_id, ordinal, chat_type, updated_at_text, payload, payload_sha256
)
SELECT
  workspace_id,
  record_key,
  NULLIF(payload ->> 'id', ''),
  ordinal,
  NULLIF(payload ->> 'type', ''),
  NULLIF(COALESCE(payload ->> 'updatedAt', payload ->> 'createdAt'), ''),
  payload - 'messages',
  md5((payload - 'messages')::text) || md5((payload - 'messages')::text)
FROM chats;

WITH chats AS (
  SELECT
    state.workspace_id,
    chat.value AS payload,
    (chat.ordinality - 1)::integer AS chat_ordinal,
    'chat:migrated:' || lpad((chat.ordinality - 1)::text, 8, '0') AS conversation_record_key
  FROM hp_workspace_states AS state
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(state.settings -> 'chatConversations') = 'array'
      THEN state.settings -> 'chatConversations'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS chat(value, ordinality)
), messages AS (
  SELECT
    chats.*,
    message.value AS message_payload,
    (message.ordinality - 1)::integer AS message_ordinal
  FROM chats
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(chats.payload -> 'messages') = 'array'
      THEN chats.payload -> 'messages'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS message(value, ordinality)
), numbered AS (
  SELECT
    *,
    (row_number() OVER (PARTITION BY workspace_id ORDER BY chat_ordinal, message_ordinal) - 1)::integer AS ordinal
  FROM messages
)
INSERT INTO hp_chat_messages(
  workspace_id, conversation_record_key, record_key, legacy_id, ordinal, order_id, created_at_text, payload, payload_sha256
)
SELECT
  workspace_id,
  conversation_record_key,
  'message:migrated:' || lpad(ordinal::text, 8, '0'),
  NULLIF(message_payload ->> 'id', ''),
  ordinal,
  NULLIF(message_payload ->> 'orderId', ''),
  NULLIF(message_payload ->> 'createdAt', ''),
  message_payload,
  md5(message_payload::text) || md5(message_payload::text)
FROM numbered;

UPDATE hp_workspace_states
SET settings = settings - 'chatConversations',
    collection_presence = jsonb_set(collection_presence, '{chatConversations}', 'true'::jsonb, true)
WHERE jsonb_typeof(settings -> 'chatConversations') = 'array';
