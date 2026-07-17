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
- Offline read access to the last synchronized dashboard, orders, search, ledger, settlement, archive, and receivables. Posting remains online-only.
- Role-aware navigation and actions for Owner, Master, Broker, Agent, Special Broker, and Special Agent.
- Money transfer form with live source-to-payout conversion.
- Order and Transfer Source, Rate, and Payout fields calculate the third value from whichever two values are entered.
- Saved sender and receiver details for Brokers and Special Brokers.
- Contact suggestions dismiss when a new name is typed, and returned orders can be corrected and resubmitted with their original number.
- Master order forwarding, payer payment confirmation, optional proof photos, and void requests.
- Color-coded Orderbook and Pending & Cancelled statuses for assigned, returned, cancelled, and voided orders.
- Dashboard Orderbook uses the same status colors as the full Orderbook.
- Assignment messages delivered to payout actors, with replies, reactions, and Master message forwarding in chat.
- Master Pending & Cancelled order view with direct payout-actor reminders.
- Internal transfers with approval, plus Master journal and withdrawal tools.
- Workspace search, receivable collections, chats and Master-managed groups.
- Fully collected receivables move into a separate monthly collapsible Archive section when their balance is closed.
- Chat opens at the message composer and Reply returns focus to the composer.
- Master ledger with a collapsible Income Statement, permanent income snapshots, Actors management, invite codes, and transfer permissions.
- Per-USD-Agent payout divisors and percentages, frozen onto future Base USD rows without changing the Agent ledger.
- Owner Master creation and subscription controls.
- Master-forwarded orders show the payout actor and payer-specific order number in their state.
- Settlement balances grouped by Broker, Agent, and Special Agent roles.
- Currency-safe storage: USD/EUR use cents, while ETB/ERN use whole units.
- Currency conversion flow screen.
- Confirmation screen that submits Broker and Special Broker orders for Master routing.
