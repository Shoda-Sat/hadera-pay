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
- Login, signup, session restore, and logout using the HaderaPay server.
- Role-aware mobile dashboard and orderbook.
- Money transfer form with live source-to-payout conversion.
- Saved sender and receiver details for Brokers and Special Brokers.
- Master-forwarded orders show the payout actor in their state.
- Settlement balances grouped by Broker, Agent, and Special Agent roles.
- Currency-safe storage: USD/EUR use cents, while ETB/ERN use whole units.
- Currency conversion flow screen.
- Confirmation screen that submits Broker and Special Broker orders for Master routing.
