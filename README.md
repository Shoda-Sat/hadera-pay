# HaderaPay Ledger Architecture

## Required server secrets

The server does not contain a default owner password. Set `OWNER_PASSWORD` before starting it. The value must contain at least 12 characters. `OWNER_USER` is optional and defaults to `Owner`.

For a Render deployment, open the web service's **Environment** page and add `OWNER_PASSWORD` as a secret environment variable. Use a newly generated password that has never appeared in source control. Do not put the password in this repository or in a committed `.env` file.

For local PowerShell development, set the value only for the current terminal session before starting the server:

```powershell
$env:OWNER_PASSWORD = "your-new-password-of-at-least-12-characters"
npm start
```

If the owner password has already been changed from inside HaderaPay, the database contains its secure hash and that password remains the login credential. The `OWNER_PASSWORD` environment value is still required as a secure bootstrap credential for a new database.

## Private file storage

HaderaPay stores new payment proofs, chat photos, and voice messages in a private Cloudflare R2 bucket. The web and Android clients upload directly through five-minute signed upload URLs, and authenticated downloads use two-minute signed URLs. R2 credentials must exist only in the server environment:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_ENDPOINT` (for example, `https://ACCOUNT_ID.r2.cloudflarestorage.com`)

Keep public bucket access disabled. The R2 token should have Object Read & Write access to only the HaderaPay bucket. The web origin must be included in the bucket's CORS policy for `PUT`, `GET`, and `HEAD` requests.

New payment images are limited to 1 MB after client compression, payment documents to 8 MB, chat photos to 5 MB, and voice messages to 5 MB or five minutes. The server independently verifies the uploaded size and content type before activating each file.

Master can open **Settings > Private File Storage** in either client to verify the connection and move older Base64 attachments out of `auth-db.json` in small batches. Existing embedded attachments remain readable until they are migrated.

R2 is object storage, not the financial database. Accounts, orders, transfers, journals, and reports remain in the application database and should eventually be migrated to PostgreSQL.

This starter implements the core of a multi-tier payment routing and settlement system around an immutable double-entry ledger.

The design has one non-negotiable rule: financial truth lives in `journal_entries` and `ledger_lines`. Actor balances are derived by summing ledger lines. There is no mutable `balance` column on users, wallets, orders, or transfers.

## Files

- `sql/schema.sql` contains the PostgreSQL schema, constraints, balance view, immutable-ledger triggers, and deferred journal balancing trigger.
- `src/domain.ts` contains shared money, FX, commission, and validation helpers.
- `src/ledger.ts` contains balanced journal posting and perfect journal reversal logic.
- `src/orders.ts` contains the order lifecycle and order payment/void posting logic.
- `src/transfers.ts` contains approval/receive flows for internal transfers and top-ups.
- `src/settlements.ts` contains net settlement clearing for Brokers, Agents, and Special Brokers.

## Actors And Accounts

Actors are stored in `users` with one of these roles:

- `MASTER`: central clearinghouse and administrator.
- `BROKER`: initiates outward payment orders.
- `AGENT`: fulfills and pays out orders.
- `SPECIAL_BROKER`: can initiate orders like a broker and pay routed orders like an agent.

Each actor has one `ACTOR_CLEARING` ledger account per currency. Platform accounts are ownerless ledger accounts:

- `MASTER_CASH`: money actually held or received by Master.
- `MASTER_FX_CLEARING`: balancing account for cross-currency journals.
- `MASTER_FEE_REVENUE`: commission revenue.

The schema stores currencies as three-letter ISO-style codes. The local preview app currently exposes `USD`, `ETB`, `EUR`, and `ERN`.

Special Broker netting requires no special balance table. The same actor can be debited for broker activity and credited for agent activity. Settlement simply sums that Special Broker's ledger lines by currency and nets the result.

## Order State Machine

Allowed states:

- `DRAFT`: broker is preparing the order.
- `PENDING_FORWARD`: order is submitted to Master for routing.
- `ASSIGNED`: Master routed the order to an Agent or Special Broker.
- `PAID`: paying actor completed payout and the journal was posted.
- `CANCELLED`: Master cancelled before payment; no final payment journal exists.
- `VOIDED`: paid order was reversed during the void window with Master consent.

Main transitions:

```text
DRAFT -> PENDING_FORWARD -> ASSIGNED -> PAID -> VOIDED
                         \-> CANCELLED
PENDING_FORWARD ---------> CANCELLED
```

Validation rule: `sender_name` is optional, but at least one of `receiver_name`, `receiver_account_number`, `receiver_phone_number`, or `remarks` is required. This is enforced in both SQL and TypeScript.

## Transfer State Machine

Required states:

- `PENDING_APPROVAL`: Agent-to-Agent and Broker-to-Master transfers wait for Master approval.
- `APPROVED`: Master approved and the ledger journal was posted.
- `REJECTED`: Master rejected; no journal is posted.

Top-up states:

- `PENDING_RECEIVE`: Master initiated a top-up and waits for the receiver.
- `RECEIVED`: receiver accepted and the ledger journal was posted.

## Order Payment Journal

For a same-currency order without FX:

```text
Debit  Broker ACTOR_CLEARING      source amount + commission
Credit Agent ACTOR_CLEARING       payout amount
Credit MASTER_FEE_REVENUE         commission, when present
```

For a cross-currency order, the journal is balanced independently per currency:

```text
Debit  Broker ACTOR_CLEARING      source amount + commission, source currency
Credit MASTER_FX_CLEARING         source amount, source currency
Credit MASTER_FEE_REVENUE         commission, source currency

Debit  MASTER_FX_CLEARING         payout amount, payout currency
Credit Agent ACTOR_CLEARING       payout amount, payout currency
```

Voiding never edits the original lines. It posts a reversal journal with every debit and credit flipped.

## Settlement

Settlement is another journal source type. It clears outstanding actor positions against `MASTER_CASH`.

For a broker owing Master:

```text
Debit  MASTER_CASH
Credit Broker ACTOR_CLEARING
```

For Master owing an agent:

```text
Debit  Agent ACTOR_CLEARING
Credit MASTER_CASH
```

For Special Brokers, compute the actor account balance by currency and settle only the net position.
