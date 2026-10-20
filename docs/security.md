# Security checklist and threat model

## Data classification

| Class | Examples | Where | Controls |
| --- | --- | --- | --- |
| **Restricted (PHI)** | diagnosis, advice, consultation reason, doctor notes | `prescriptions.*_enc`, `consultations.*_enc` | AES-256-GCM field encryption, access limited to the two participants + admins, every read of a prescription is audit logged, redacted from logs |
| **Restricted (secrets)** | password hashes, MFA secrets, refresh tokens | `users`, `refresh_tokens` | scrypt for passwords, MFA secret encrypted, refresh tokens stored as SHA-256 only |
| **Confidential (PII)** | phone number, DOB, email, name | `profiles`, `users` | phone encrypted; DB encrypted at rest; never logged |
| **Confidential (financial)** | payment amounts, provider ids | `payments` | no card data ever touches us (provider hosted checkout), webhook HMAC |
| **Internal** | audit logs, metrics, job payloads (ids only) | `audit_logs`, `jobs` | append-only trigger, admin + MFA to read |
| **Public** | verified doctor profiles, open slots | `doctors`, `availability_slots` | read only, rate limited |

Prescription medication lists are kept as plaintext JSON on purpose. They aren't identifying on their own (the link to a person is the encrypted bits plus access control), and keeping them in clear means pharmacy integrations and analytics can work without decrypting everything.

## Encryption

- **In transit**: TLS terminates at the load balancer, which is HTTPS only with HSTS (helmet sets the header too). Postgres and Redis connections in production use TLS (`sslmode=require` in `DATABASE_URL`, `rediss://`).
- **At rest**: managed Postgres storage encryption (KMS), and encrypted snapshots and backups.
- **Field level**: `src/lib/crypto.js`, AES-256-GCM with a random 96-bit IV per value and an auth tag, so tampering is detected (there's a unit test for it). The stored format is `version:iv:tag:ciphertext`.

### Key rotation

Keys are versioned (`DATA_ENCRYPTION_KEYS=v1:...,v2:...`, `DATA_ENCRYPTION_ACTIVE_KEY=v2`).

1. Add the new key and make it active, then deploy. New writes use v2 and old rows still decrypt with v1.
2. Run `npm run rotate-keys`. It re-encrypts rows in batches with `FOR UPDATE SKIP LOCKED`, so it's safe to run alongside live traffic.
3. Remove v1 once the script reports nothing left.

In production the data keys come from AWS Secrets Manager / KMS via external-secrets. A future improvement is envelope encryption with per-tenant DEKs wrapped by a KMS CMK.

**JWT signing secret**: rotate by deploying the new secret. Access tokens live 15 minutes, so the worst case is everyone refreshing once. Refresh tokens are opaque and not affected. If we moved to asymmetric keys (RS256 with a `kid`), we could rotate with zero disruption. That's on the list.

**Webhook secret**: rotate together with the provider dashboard. The verify function can be extended to accept two secrets during the overlap window.

## Authentication and authorization

- Passwords: at least 10 chars, mixed case and a digit. Hashed with scrypt (N=2^15, r=8, p=1) and compared in constant time. Unknown emails still run a hash, so response timing doesn't reveal which emails exist.
- Lockout: 5 failed attempts locks the account for 15 minutes (audit logged). On top of that, auth endpoints are rate limited (10 per 5 minutes per IP by default).
- MFA: TOTP (RFC 6238, tested against the RFC vectors). Login with MFA is two-step: the password step returns a short-lived `mfaToken` (5 minutes, separate JWT audience), then the TOTP step returns the real tokens. **Admin routes require an access token that was issued after MFA** (`mfa: true` claim), and admins can't disable MFA. Enabling MFA revokes existing sessions.
- Access tokens: HS256 JWT, 15 minutes, with `aud` and `typ` checked and the algorithm pinned (no `alg: none` or algorithm confusion).
- Refresh tokens: random 48 bytes, stored hashed, single use with rotation. Reusing an old token revokes the whole session family, which catches stolen tokens. Disabling a user revokes all of their tokens.
- RBAC: roles are `patient`, `doctor` and `admin`. On top of the role check, every consultation/prescription query checks **ownership** (the patient is the consultation's patient, the doctor is the consultation's doctor). Other people's resources return 404 rather than 403, so ids can't be probed.
- Users can't self-register as admin (schema only allows patient/doctor). Admins are created by an operator.

## OWASP Top 10 (2021) mapping

| Risk | Mitigation here |
| --- | --- |
| A01 Broken access control | role middleware + ownership checks in every service query, 404 on foreign ids, admin needs MFA, tests for cross-user access |
| A02 Cryptographic failures | TLS everywhere, AES-GCM field encryption, scrypt, hashed refresh tokens, no secrets in code (`.env` git-ignored, gitleaks in CI) |
| A03 Injection | parameterised SQL only; dynamic parts (ORDER BY, column lists) come from server-side whitelists, never from input; LIKE wildcards escaped |
| A04 Insecure design | state machine for consultations, idempotency keys, saga with compensation, threat model below |
| A05 Security misconfiguration | helmet headers, `x-powered-by` off, strict CORS allow-list, env validated at boot (refuses to start with short secrets), non-root read-only container, restricted Pod Security, NetworkPolicies |
| A06 Vulnerable components | `npm audit` + Trivy image scan fail CI on high/critical, Dependabot weekly |
| A07 Identification & auth failures | lockout, rate limits, MFA, token rotation + reuse detection, short access TTL |
| A08 Software & data integrity | `npm ci` from lockfile, signed webhooks (HMAC, constant-time compare), immutable image tags, append-only audit log |
| A09 Logging & monitoring failures | structured logs with request id, audit trail for auth/PHI/admin actions, alerts for 5xx burn rate, bad webhook signatures and dead-lettered jobs |
| A10 SSRF | the service never fetches user-supplied URLs; the only outbound calls go to fixed provider endpoints from config |

Also: JSON body limit of 100kb, `statement_timeout` against slow-query DoS, and validation with zod on every input. Unknown fields are rejected where it matters (`.strict()` on profile updates).

## Attack surface

| Entry point | Exposure | Controls |
| --- | --- | --- |
| Public REST API (`/api/v1`) | internet | WAF, TLS, rate limits, auth, validation |
| `POST /payments/webhook` | internet (provider) | HMAC signature on raw body, event-id dedupe, can additionally be IP allow-listed at the LB |
| `/metrics`, `/health/*` | cluster only | NetworkPolicy restricts to ingress/monitoring namespaces; the LB doesn't route `/metrics` |
| `/docs` (Swagger UI) | can be disabled in prod at the ingress | read-only, no secrets |
| Postgres / Redis | private subnets | security groups, TLS, separate DB users for app vs migrations (recommended) |
| CI/CD | GitHub | branch protection, required reviews, `production` environment approval, least-privilege `permissions:` |
| Admin console | internet | admin role + mandatory MFA, all actions audited |
| Dependencies | supply chain | lockfile, audit, Trivy, Dependabot |

## Threat model (STRIDE)

| Threat | Example | Mitigation | Residual risk |
| --- | --- | --- | --- |
| **Spoofing** | stolen password | MFA (mandatory for admins), lockout, rate limiting | patients/doctors without MFA. Recommend enforcing MFA for doctors. |
| Spoofing | forged payment webhook confirms a booking for free | HMAC over the raw body with a shared secret, constant-time compare | secret leak, mitigated by rotation |
| Spoofing | stolen refresh token | rotation + reuse detection revokes the family | the attacker can use it until the real user refreshes. Could bind to device later. |
| **Tampering** | editing audit history to hide access | DB trigger blocks UPDATE/DELETE, archived to WORM storage | DB superuser can still drop the trigger. Separate audit DB role / external sink recommended. |
| Tampering | modifying ciphertext in DB | GCM auth tag, decrypt fails loudly | none |
| Tampering | mass assignment (`role: admin` on register / profile) | zod schemas whitelist fields | none |
| **Repudiation** | doctor denies writing a prescription | audit log with actor, IP, request id, written in the same transaction | none |
| **Information disclosure** | patient A reads patient B's prescription (IDOR) | ownership checks, 404 for foreign ids, integration tests | none known |
| Information disclosure | PHI in logs | pino redaction paths, ids only in job payloads | new fields have to be added to the redact list |
| Information disclosure | DB dump leaked | field encryption on PHI + MFA secrets; keys stored separately from data | names/emails readable in the dump |
| Information disclosure | user enumeration via login | same message and similar timing for unknown email vs wrong password | register still says "email taken" (accepted trade-off for UX) |
| **Denial of service** | booking spam / slot hoarding (hold every slot without paying) | per-user rate limits, 10 minute holds that expire, patient overlap check | a bot army with many accounts. Add per-patient pending-hold cap + CAPTCHA at signup. |
| Denial of service | expensive search queries | limit capped at 50, short cache, statement timeout | none significant |
| **Elevation of privilege** | patient calling doctor/admin endpoints | role middleware on every route, admin MFA | none known |
| Elevation of privilege | JWT `alg` confusion | algorithm pinned to HS256, audience checked | none |

## Audit logging

What gets logged (append-only `audit_logs`): registration, login, failed MFA, lockouts, refresh token reuse, MFA on/off, profile changes, doctor profile changes and verification, slot changes, every booking/cancellation/state change, every payment outcome and refund, prescription creation, **every prescription read**, admin reads of consultations, admin user enable/disable, admin job retries.

Each row has the actor id and role, action, entity, metadata (no PHI values), IP, request id and timestamp. Admins can search it at `GET /admin/audit-logs`.

## Dependency and image scanning

- `npm audit --omit=dev --audit-level=high` in CI (currently 0 vulnerabilities).
- Trivy scans the built image and fails on HIGH/CRITICAL fixable issues.
- gitleaks scans for committed secrets.
- Dependabot for npm, Docker base image and GitHub Actions.

## Checklist

- [x] TLS in transit, encryption at rest, field-level encryption for PHI
- [x] Versioned keys + rotation script
- [x] scrypt password hashing, lockout, rate limiting on auth
- [x] TOTP MFA, mandatory for admins
- [x] Short-lived access tokens, rotating refresh tokens with reuse detection
- [x] RBAC + per-record ownership checks
- [x] Input validation on every endpoint
- [x] Parameterised SQL only
- [x] Idempotency on booking, cancellation and prescriptions; webhook dedupe
- [x] Signed webhooks
- [x] Security headers (helmet), CORS allow-list, body size limit
- [x] Append-only audit log of security, PHI and admin events
- [x] Log redaction of credentials and PHI
- [x] Secrets only via environment / secret manager, validated at boot
- [x] Non-root, read-only container, dropped capabilities, NetworkPolicies
- [x] Dependency, image and secret scanning in CI
- [ ] Enforce MFA for doctors (config switch, product decision)
- [ ] Per-patient cap on concurrent pending holds
- [ ] Asymmetric JWT keys with `kid` for zero-downtime rotation
- [ ] Ship audit log to an external immutable sink in real time
