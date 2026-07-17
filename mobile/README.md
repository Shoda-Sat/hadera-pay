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
- Order Source, Rate, and Payout fields calculate the third value from whichever two the Broker enters.
- Saved sender and receiver details for Brokers and Special Brokers.
- Contact suggestions dismiss when a new name is typed, and returned orders can be corrected and resubmitted with their original number.
- Master order forwarding, payer payment confirmation, optional proof photos, and void requests.
- Color-coded Orderbook and Pending & Cancelled statuses for assigned, returned, cancelled, and voided orders.
- Assignment messages delivered to payout actors, with replies, reactions, and Master message forwarding in chat.
- Master Pending & Cancelled order view with direct payout-actor reminders.
- Internal transfers with approval, plus Master journal and withdrawal tools.
- Workspace search, receivable collections, chats and Master-managed groups.
- Master ledger, permanent income snapshots, Actors management, invite codes, and transfer permissions.
- Owner Master creation and subscription controls.
- Master-forwarded orders show the payout actor and payer-specific order number in their state.
- Settlement balances grouped by Broker, Agent, and Special Agent roles.
- Currency-safe storage: USD/EUR use cents, while ETB/ERN use whole units.
- Currency conversion flow screen.
- Confirmation screen that submits Broker and Special Broker orders for Master routing.
