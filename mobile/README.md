# HaderaPay Mobile

React Native mobile app for the HaderaPay Android experience.

## Run

```bash
cd mobile
npm install
npm run android
```

By default the app talks to `https://haderapay.com`. To point a build at another backend, set `EXPO_PUBLIC_HADERAPAY_API_URL` before starting or building the app.

## Included

- HaderaPay branding, colors, and compact operational layout.
- Login, signup, session restore, password reset, and visible logout controls.
- Offline read access to the last synchronized dashboard, orders, search, ledger, settlement, Report, and receivables. Posting remains online-only.
- Role-aware navigation and actions for Owner, Master, Broker, Agent, Special Broker, and Special Agent.
- Money transfer form with live source-to-payout conversion.
- Order and Transfer Source, Rate, and Payout fields calculate the third value from whichever two values are entered.
- Saved sender and receiver details for Brokers and Special Brokers.
- Receiver City is saved with receiver contacts, and Credit Reminder notes stay private to the borrowing actor's Receivables record.
- Contact suggestions dismiss when a new name is typed, and returned orders can be corrected and resubmitted with their original number.
- Master order forwarding, payer payment confirmation, optional proof photos, and void requests.
- Color-coded Orderbook and Pending & Cancelled statuses for assigned, returned, cancelled, and voided orders.
- Dashboard Orderbook uses the same status colors as the full Orderbook.
- Assignment messages delivered to payout actors, with replies, reactions, and Master message forwarding in chat.
- Master Pending & Cancelled order view with direct payout-actor reminders.
- Internal transfers with approval, plus Master journal and withdrawal tools.
- Consolidated workspace search returns one permitted result per transaction and participant instead of duplicate order, ledger, receivable, and Report rows.
- Account-selectable inactivity logout from 10 seconds to 2 hours, including offline-cache expiry, plus server lockout warnings after repeated failed logins.
- Ledger and Report transactions can be sorted by date or Order/Transfer number.
- Fully collected receivables move into a separate monthly collapsible Report section when their balance is closed.
- Repeated Report snapshots are deduplicated, reported orders do not return to the live orderbook, and signed currency positions keep the Actor/Master direction visible.
- Master can reset one Actor's active data while preserving Ledger, Master Bank, Report, login, and Actor settings.
- Old unforwarded and unpaid orders move to the top after login, with confirmation prompts for Master and payer return/cancel actions.
- Approved voids are locked after balance closing, permanently excluded from financial calculations, and highlighted red in Master, initiator, and payer ledgers.
- Chat opens at the message composer and Reply returns focus to the composer.
- Master ledger with a collapsible Income Statement, permanent income snapshots, Actors management, invite codes, and transfer permissions.
- Master ledger with an independent collapsible Bank Account, green Money In, red Money Out, running currency balances, reasoned funding, and shareable monthly statements.
- Per-USD-Agent payout divisors and percentages, frozen onto future Base USD rows without changing the Agent ledger.
- Owner Master creation with selectable base currency and subscription controls.
- Master-forwarded orders show the payout actor and payer-specific order number in their state.
- Settlement balances grouped by Broker, Agent, and Special Agent roles.
- Currency-safe storage: USD/EUR use cents, while ETB/ERN use whole units.
- Currency conversion flow screen.
- Confirmation screen that submits Broker and Special Broker orders for Master routing.
