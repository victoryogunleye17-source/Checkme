# CheckMe — Real Load Testing on Vercel

This is a **real** HTTP load testing tool that works on Vercel.

It uses [autocannon](https://github.com/mcollina/autocannon) to send actual concurrent HTTP requests and returns measured results (latency, requests/sec, error rate, etc.).

## Important limits (because of Vercel)

Vercel serverless functions have short timeouts. Therefore this version enforces:

- Max **12 seconds** duration per test
- Max **100** concurrent connections
- Capacity ramp uses short rounds (max 6s each)

These limits keep the function alive so you get real results instead of timeouts.

## Deploy to Vercel

1. Push this folder to a GitHub repo (or use Vercel CLI).
2. Import the project in Vercel.
3. Deploy.

Or with CLI:

```bash
npm i -g vercel
vercel
```

## Local testing

```bash
npm install
npx vercel dev
```

Then open the URL Vercel gives you.

## Safety

- Only test websites you own or have permission to test.
- Private/localhost targets are blocked by default (enable the checkbox only for local dev).
- Every request includes a unique `X-CheckMe-Test` header so you can filter it in your logs.

## What you get

- Real measured latency (avg, p50, p90, p99)
- Real requests per second
- Real error rate
- Capacity ramp that finds approximate max stable concurrency
- Clean dark UI

No simulation. No fake numbers.
