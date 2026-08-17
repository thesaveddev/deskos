# DeskOS Load Tests

## Prerequisites

Install k6: https://k6.io/docs/get-started/installation/

```bash
# macOS
brew install k6

# Windows
winget install k6

# Linux
sudo snap install k6
```

## Running

### Smoke test (quick validation)
```bash
k6 run tests/load/load-test.js \
  --vus 5 \
  --duration 30s \
  --env BASE_URL=http://localhost:4000
```

### Load test (target 50 concurrent users)
```bash
k6 run tests/load/load-test.js \
  --env BASE_URL=http://localhost:4000 \
  --env TEST_EMAIL=your@email.com \
  --env TEST_PASSWORD=your-password
```

### Stress test (push to 200 users)
```bash
k6 run tests/load/load-test.js \
  --env BASE_URL=http://your-deployed-url.onrender.com \
  --env TEST_EMAIL=your@email.com \
  --env TEST_PASSWORD=your-password \
  --vus 200 \
  --duration 5m
```

## Thresholds

The test enforces:
- **p95 latency < 2s** — 95% of requests complete within 2 seconds
- **p99 latency < 5s** — 99% of requests complete within 5 seconds
- **Error rate < 10%** — fewer than 1 in 10 requests fail

## Metrics

| Metric | Description |
|---|---|
| `http_req_duration` | Request latency (built-in) |
| `errors` | Rate of failed checks |
| `login_duration` | Login endpoint latency |
| `ticket_list_duration` | Ticket list endpoint latency |
| `health_duration` | Health check endpoint latency |

## Endpoints tested

- `GET /healthz` — health check
- `GET /readyz` — readiness probe
- `GET /api/v1/meta` — metadata
- `POST /api/v1/auth/login` — authentication
- `GET /api/v1/tickets` — ticket list
- `GET /api/v1/devices` — device list
- `GET /api/v1/sessions` — session list
- `GET /api/v1/audit` — audit log
- `GET /api/v1/marketplace/apps` — marketplace catalog
- `GET /api/v1/monitoring/rules` — monitoring rules
