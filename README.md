# Amrutam Telemedicine API

Backend for Amrutam's online consultations. Patients find an Ayurvedic doctor, book a slot, pay, attend the consultation and get a prescription. Doctors manage their availability and consultations. Admins verify doctors, look at analytics and go through the audit trail.

Stack: **Node.js 20+ / Express, PostgreSQL 16, Redis (optional)**, Prometheus + OpenTelemetry, Docker, Kubernetes, GitHub Actions.

- Architecture: [docs/architecture.md](docs/architecture.md) (diagrams, booking saga, partitioning, caching, DR)
- Security: [docs/security.md](docs/security.md) (checklist, threat model, OWASP mapping)
- API: [docs/openapi.yaml](docs/openapi.yaml), also served as Swagger UI at `http://localhost:4000/docs`
- Demo video (about 4 min, captions, no audio): [docs/demo/demo.mp4](docs/demo/demo.mp4)

## What's implemented

- **Users and auth**: register/login, roles (patient, doctor, admin), TOTP MFA (required for admins), short-lived JWT access tokens, rotating refresh tokens with reuse detection, account lockout.
- **Doctors**: profile, admin verification, search by name, specialization, language, fee, rating and day with availability. Doctors publish availability slots, and overlapping slots are rejected.
- **Booking**: holds the slot and creates a pending payment. A signed payment webhook confirms the booking. If nobody pays, the hold expires and the slot is released. Late payments are refunded automatically. It's safe under concurrency (row lock + unique index) and safe to retry (`Idempotency-Key`).
- **Consultation lifecycle**: `pending_payment → confirmed → in_progress → completed`, plus cancellation (with cutoff and refund), no-show and expiry.
- **Prescriptions**: one per consultation, written by the doctor. Diagnosis and advice are encrypted, and every read is audit logged.
- **Audit trail**: append-only, monthly partitioned table that is searchable by admins.
- **Admin analytics**: overview (bookings by status, revenue, cancellation / no-show rates, top doctors) plus daily rollups built by a background job.
- **Async jobs**: Postgres-backed queue (transactional outbox) with retries, exponential backoff + jitter and a dead-letter state.
- **Ops**: structured logs with request ids, Prometheus metrics with SLO alerts and a Grafana dashboard, OTel traces to Jaeger, health checks, graceful shutdown.

## Running locally

### With Docker (everything)

```bash
docker compose up --build
```

| | |
| --- | --- |
| API | http://localhost:4000 (docs at `/docs`) |
| Grafana | http://localhost:3001 (dashboard "Amrutam API") |
| Prometheus | http://localhost:9090 |
| Jaeger | http://localhost:16686 |

Load demo data:

```bash
docker compose run --rm api node scripts/seed.js
```

### Without Docker

You need Node 20+ and a Postgres 13+ database. Redis is optional.

```bash
cp .env.example .env        # fill in DATABASE_URL and the secrets (commands to generate them are in the file)
npm install
npm run migrate
npm run seed                # demo users, doctors and a week of slots
npm run dev                 # API on :4000
npm run worker              # in another terminal - expiry, refunds, notifications, rollups
```

Every seeded account uses the password `Password123`:

- `admin@amrutam.test`: MFA is on. The seed prints the TOTP secret; get the current code with `npm run totp -- <secret>`.
- `patient@amrutam.test`, `patient2@amrutam.test`
- `doctor1@amrutam.test` … `doctor5@amrutam.test`

### Environment variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | | Postgres connection string |
| `REDIS_URL` | no | | without it, cache and rate limits are in-process |
| `JWT_ACCESS_SECRET` | yes | | ≥ 32 chars |
| `JWT_ACCESS_TTL` | no | `15m` | |
| `REFRESH_TOKEN_TTL_DAYS` | no | `30` | |
| `REQUIRE_ADMIN_MFA` | no | `true` | |
| `DATA_ENCRYPTION_KEYS` | yes | | `v1:<base64 32 bytes>[,v2:...]` |
| `DATA_ENCRYPTION_ACTIVE_KEY` | yes | | version used for new writes |
| `PAYMENT_WEBHOOK_SECRET` | yes | | HMAC secret shared with the payment provider |
| `BOOKING_HOLD_MINUTES` | no | `10` | how long a slot is held for payment |
| `CANCELLATION_CUTOFF_HOURS` | no | `2` | patients can't cancel later than this |
| `APP_TIMEZONE` | no | `Asia/Kolkata` | what "a day" means for search / stats |
| `CORS_ORIGINS` | no | | comma separated allow-list |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SEC` | no | `120` / `60` | general limit |
| `AUTH_RATE_LIMIT_MAX` | no | `10` | per 5 minutes on auth endpoints |
| `OTEL_ENABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT` | no | `false` | tracing |
| `MIGRATE_ON_START` | no | `false` | handy for single-instance setups |

The app validates its config on boot and refuses to start if something is missing or too weak.

## Tests

```bash
npm run lint
npm run test:unit                                                            # no DB needed
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/amrutam_test npm test  # unit + integration
```

The integration tests run against a real Postgres database. They create the schema and truncate tables themselves, so use a throwaway database. They cover:

- concurrent booking of the same slot (exactly one wins)
- idempotent replays and key reuse
- webhook dedupe and bad signatures
- hold expiry releasing the slot, and refund of a late payment
- cancellation cutoff and refunds
- the full consultation → prescription flow and invalid transitions
- cross-user access (IDOR)
- refresh token reuse detection, MFA, lockout
- the append-only audit log, analytics, metrics and the error format

CI (`.github/workflows/ci.yml`) runs lint and tests against a Postgres service container, then `npm audit`, gitleaks, a Docker build and a Trivy image scan. On `main` it pushes the image and deploys through a protected `production` environment.

## Trying the booking flow by hand

```bash
API=http://localhost:4000/api/v1

# log in as a patient
TOKEN=$(curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"patient@amrutam.test","password":"Password123"}' | jq -r .accessToken)

# find a doctor and an open slot
DOCTOR=$(curl -s "$API/doctors?specialization=Panchakarma" | jq -r '.data[0].id')
SLOT=$(curl -s "$API/doctors/$DOCTOR/slots" | jq -r '.data[0].id')

# book it (run this twice with the same key - you get the same booking back)
curl -s -X POST $API/consultations -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'Idempotency-Key: my-first-booking' \
  -d "{\"slotId\":\"$SLOT\",\"reason\":\"acidity after meals\"}" | jq

# pretend to be the payment provider
node scripts/fake-webhook.js <orderId from the response>
```

## Project layout

```
src/
  config/            env validation
  db/                pool, transactions with retry, migrator
  lib/               crypto, totp, cache, metrics, tracing, retry, logger
  middlewares/       auth, validation, idempotency, rate limit, errors
  modules/
    auth/ users/ doctors/ consultations/ prescriptions/ payments/ audit/ admin/
  jobs/              queue, handlers, recurring schedule
  container.js       dependency wiring
  app.js server.js worker.js
migrations/          plain SQL
scripts/             migrate, seed, rotate-keys, totp, fake-webhook
tests/unit tests/integration
infra/k8s            kustomize manifests (api, worker, HPA, PDB, migrate job, network policies)
infra/prometheus     scrape config + SLO alerts
infra/grafana        datasource + dashboard provisioning
docs/                architecture, security, openapi, demo script
```

## Design decisions worth calling out

- **Plain SQL with `pg` instead of an ORM.** The hard parts of this system are locking, partial indexes, partitioning and `SKIP LOCKED`, and those are easier to get right (and to review) in SQL.
- **The job queue lives in Postgres, not in Redis/BullMQ.** Jobs are inserted in the same transaction as the change that caused them (outbox), so a booking can't commit without its expiry timer, and Redis stays optional. At this volume (a few jobs per second) Postgres handles it easily. If it ever stops being enough, the handlers can move to SQS or Kafka without changing the services.
- **The payment provider is a mock** (`mockpay`) behind a small interface. A Razorpay/Stripe adapter would implement the same `refund()` plus webhook signature format.
- **Notifications only log.** The SMS/email provider sits behind `notifier.send()`.
- **Video calls are out of scope.** The consultation lifecycle is tracked here; the call itself would come from a provider like Twilio/100ms, keyed by consultation id.

## Known gaps / next steps

- MFA for doctors (currently optional)
- cap on how many unpaid holds one patient can have at once
- RS256 JWTs with key ids for rotation without forcing refreshes
- Ratings/reviews after completed consultations (the columns exist; there's no endpoint yet)
- Keyset pagination for the audit log once it gets large
