# Demo video outline (about 5 minutes)

Before recording: `docker compose up --build`, then `docker compose run --rm api node scripts/seed.js`.
Keep Swagger (`/docs`), a terminal, Grafana and Jaeger open in tabs.

**0:00 - 0:40 Intro and architecture**
- One line on the problem, then the high level diagram in `docs/architecture.md`.
- API pods + worker pods from one image, Postgres as source of truth, Redis optional, Postgres job queue.

**0:40 - 1:30 Auth**
- Register a patient in Swagger, show the token pair.
- Log in as admin: show the `mfaRequired` response, get a code with `npm run totp -- <secret>`, finish the login.
- Show that the admin endpoint rejects a non-MFA token (403 MFA_REQUIRED).

**1:30 - 3:00 Booking flow (main part)**
- Search doctors with filters (`specialization`, `language`, `availableOn`).
- Book a slot with an `Idempotency-Key`, then send the same request again and point out `Idempotent-Replayed: true`.
- Try to book the same slot as the second patient: 409 SLOT_UNAVAILABLE.
- `node scripts/fake-webhook.js <orderId>`: the booking is confirmed. Send it again and show `duplicate`.
- Mention the hold expiry + late payment refund (show the test names in `booking.test.js`).

**3:00 - 3:50 Consultation + prescription**
- As the doctor: start, write the prescription, complete.
- As the patient: read the prescription.
- In psql, show the `diagnosis_enc` column is ciphertext.
- As admin: `GET /admin/audit-logs?action=prescription.viewed`.

**3:50 - 4:30 Observability**
- Grafana dashboard: request rate, p95 per route, bookings.
- Jaeger: one booking trace with the pg spans.
- A log line with the request id that matches the error response.

**4:30 - 5:00 Quality and infra**
- `npm test` output (unit + integration, including the concurrency test).
- CI workflow, k8s manifests (HPA, PDB, zone spread), security checklist.
