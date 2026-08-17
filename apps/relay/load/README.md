# Relay load/churn lab

`harness.ts` is a repeatable load test for the broker relay. It exercises the
blueprint's M5 load targets in five phases and fails (exit 1) if any phase
regresses:

1. **Join ramp** — opens `sessions` rooms (technician + agent pairs) plus
   `connections - 2*sessions` raw sockets, and measures join latency.
2. **Message churn** — every session peer sends chat and asserts its
   counterpart receives every message exactly once.
3. **Reconnect storm** — drops and rejoins every session peer with a fresh
   single-use ticket, for `reconnectRounds` rounds.
4. **Rate-limit enforcement** — a flooder is expected to receive
   `message_rate_limited`.
5. **Graceful drain** — closes everything and confirms clean teardown.

## Run

Start the relay first (it must share the same relay secret):

```bash
REDIS_URL=redis://127.0.0.1:6379 \
RELAY_PORT=4100 \
DESKOS_RELAY_SECRET=load-test-secret \
npm run dev --workspace @deskos/relay
```

Then run the harness (same secret):

```bash
LOAD_URL=ws://127.0.0.1:4100/ws \
LOAD_SECRET=load-test-secret \
npm run load --workspace @deskos/relay
```

### Smoke (defaults)

The defaults (40 connections / 8 sessions) are a fast smoke run. Use
`LOAD_*` variables for the production targets:

```bash
LOAD_CONNECTIONS=1000 LOAD_SESSIONS=100 LOAD_MESSAGES=20 \
LOAD_RECONNECTS=3 LOAD_BURST=2010 \
LOAD_URL=ws://127.0.0.1:4100/ws LOAD_SECRET=load-test-secret \
npm run load --workspace @deskos/relay
```

| Variable | Default | Meaning |
|---|---|---|
| `LOAD_URL` | `ws://127.0.0.1:4100/ws` | Relay WebSocket endpoint |
| `LOAD_SECRET` | `DESKOS_RELAY_SECRET` or dev default | Ticket-signing secret |
| `LOAD_CONNECTIONS` | `40` | Total concurrent sockets to hold |
| `LOAD_SESSIONS` | `8` | Active remote-control rooms (2 peers each) |
| `LOAD_MESSAGES` | `5` | Chat messages sent per peer |
| `LOAD_RECONNECTS` | `2` | Drop/rejoin rounds |
| `LOAD_JOIN_TIMEOUT` | `5000` | Join/message wait timeout (ms) |
| `LOAD_BURST` | `1010` | Flooder burst size (exceeds the 1000/s limit) |

## NAT / media lab

This harness covers the broker control plane. The WebRTC media plane
(direct P2P vs TURN fallback, packet loss, multi-monitor, reconnect after
reboot) is a separate Playwright/k6 NAT lab and requires two coturn nodes, per
`04-system-architecture.md` §5 Stage 2.
