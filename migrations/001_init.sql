-- gen_random_uuid() is built in from PG 13 onwards

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL,
  password_hash         text NOT NULL,
  role                  text NOT NULL CHECK (role IN ('patient', 'doctor', 'admin')),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  mfa_enabled           boolean NOT NULL DEFAULT false,
  mfa_secret_enc        text,
  failed_login_attempts int NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE profiles (
  user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  phone_enc     text,
  date_of_birth date,
  gender        text CHECK (gender IN ('male', 'female', 'other')),
  city          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  mfa         boolean NOT NULL DEFAULT false,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,
  user_agent  text,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE doctors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  specialization      text NOT NULL,
  qualifications      text,
  experience_years    int NOT NULL DEFAULT 0 CHECK (experience_years >= 0),
  consultation_fee    int NOT NULL CHECK (consultation_fee >= 0), -- paise
  languages           text[] NOT NULL DEFAULT '{}',
  bio                 text,
  rating              numeric(2, 1) NOT NULL DEFAULT 0,
  rating_count        int NOT NULL DEFAULT 0,
  is_verified         boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doctors_search_idx ON doctors (specialization, consultation_fee) WHERE is_verified;
CREATE INDEX doctors_languages_idx ON doctors USING gin (languages);

CREATE TABLE availability_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id   uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'held', 'booked', 'blocked')),
  held_until  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (doctor_id, starts_at)
);
CREATE INDEX slots_open_idx ON availability_slots (doctor_id, starts_at) WHERE status = 'open';
CREATE INDEX slots_starts_idx ON availability_slots (starts_at) WHERE status = 'open';

CREATE TABLE consultations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      uuid NOT NULL REFERENCES users (id),
  doctor_id       uuid NOT NULL REFERENCES doctors (id),
  slot_id         uuid NOT NULL REFERENCES availability_slots (id),
  status          text NOT NULL CHECK (status IN (
                    'pending_payment', 'confirmed', 'in_progress', 'completed',
                    'cancelled', 'no_show', 'expired')),
  reason_enc      text,
  notes_enc       text,
  fee             int NOT NULL,
  scheduled_start timestamptz NOT NULL,
  scheduled_end   timestamptz NOT NULL,
  started_at      timestamptz,
  ended_at        timestamptz,
  cancelled_at    timestamptz,
  cancelled_by    uuid REFERENCES users (id),
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- a slot can only back one live consultation; cancelled/expired ones free it up again
CREATE UNIQUE INDEX consultations_active_slot_key ON consultations (slot_id)
  WHERE status NOT IN ('cancelled', 'expired');
CREATE INDEX consultations_patient_idx ON consultations (patient_id, scheduled_start DESC);
CREATE INDEX consultations_doctor_idx ON consultations (doctor_id, scheduled_start DESC);
CREATE INDEX consultations_created_idx ON consultations (created_at);

CREATE TABLE prescriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL UNIQUE REFERENCES consultations (id),
  doctor_id       uuid NOT NULL REFERENCES doctors (id),
  patient_id      uuid NOT NULL REFERENCES users (id),
  medications     jsonb NOT NULL,
  diagnosis_enc   text,
  advice_enc      text,
  follow_up_date  date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, created_at DESC);

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL UNIQUE REFERENCES consultations (id),
  amount          int NOT NULL CHECK (amount >= 0),
  currency        text NOT NULL DEFAULT 'INR',
  status          text NOT NULL CHECK (status IN (
                    'pending', 'succeeded', 'failed', 'cancelled', 'refund_pending', 'refunded')),
  provider        text NOT NULL DEFAULT 'mockpay',
  provider_order_id text NOT NULL UNIQUE,
  provider_payment_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_status_idx ON payments (status, created_at);

-- every webhook event we have processed; makes replays a no-op
CREATE TABLE payment_events (
  event_id     text PRIMARY KEY,
  payment_id   uuid REFERENCES payments (id),
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

-- audit log is append-only and partitioned by month
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  actor_id    uuid,
  actor_role  text,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  metadata    jsonb NOT NULL DEFAULT '{}',
  ip          text,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);

CREATE FUNCTION ensure_audit_partition(month_start date) RETURNS void AS $$
DECLARE
  part_name text := 'audit_logs_' || to_char(month_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
    part_name, month_start, (month_start + interval '1 month')::date
  );
END;
$$ LANGUAGE plpgsql;

SELECT ensure_audit_partition(date_trunc('month', now())::date);
SELECT ensure_audit_partition((date_trunc('month', now()) + interval '1 month')::date);

CREATE FUNCTION audit_logs_block_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_changes();

CREATE TABLE idempotency_keys (
  user_id         uuid NOT NULL,
  key             text NOT NULL,
  method          text NOT NULL,
  path            text NOT NULL,
  request_hash    text NOT NULL,
  status          text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

CREATE TABLE jobs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts    int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  run_at      timestamptz NOT NULL DEFAULT now(),
  locked_at   timestamptz,
  last_error  text,
  dedupe_key  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_pickup_idx ON jobs (run_at) WHERE status = 'queued';
-- a dedupe key can only ever be enqueued once (expiry per booking, refund per payment, cron tick)
CREATE UNIQUE INDEX jobs_dedupe_key ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE daily_stats (
  day                 date PRIMARY KEY,
  consultations_total int NOT NULL,
  completed           int NOT NULL,
  cancelled           int NOT NULL,
  no_show             int NOT NULL,
  revenue             bigint NOT NULL,
  new_patients        int NOT NULL,
  computed_at         timestamptz NOT NULL DEFAULT now()
);
