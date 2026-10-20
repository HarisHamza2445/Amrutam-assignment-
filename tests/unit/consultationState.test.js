const { STATUS, canTransition, checkStart, checkNoShow, checkPatientCancel } = require('../../src/modules/consultations/consultation.state');

const at = (iso) => new Date(iso);
const consultation = {
  status: STATUS.CONFIRMED,
  scheduled_start: at('2030-01-01T10:00:00Z'),
  scheduled_end: at('2030-01-01T10:30:00Z'),
};

describe('consultation state machine', () => {
  it.each([
    [STATUS.PENDING_PAYMENT, STATUS.CONFIRMED, true],
    [STATUS.PENDING_PAYMENT, STATUS.EXPIRED, true],
    [STATUS.CONFIRMED, STATUS.IN_PROGRESS, true],
    [STATUS.IN_PROGRESS, STATUS.COMPLETED, true],
    [STATUS.PENDING_PAYMENT, STATUS.IN_PROGRESS, false],
    [STATUS.COMPLETED, STATUS.CANCELLED, false],
    [STATUS.CANCELLED, STATUS.CONFIRMED, false],
    [STATUS.IN_PROGRESS, STATUS.CANCELLED, false],
  ])('%s -> %s allowed: %s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
  });

  it('only lets the doctor start within the window', () => {
    expect(checkStart(consultation, at('2030-01-01T09:30:00Z'))).toMatch(/early/);
    expect(checkStart(consultation, at('2030-01-01T09:50:00Z'))).toBeNull();
    expect(checkStart(consultation, at('2030-01-01T10:31:00Z'))).toMatch(/passed/);
  });

  it('allows no-show only after the grace period', () => {
    expect(checkNoShow(consultation, at('2030-01-01T10:05:00Z'))).not.toBeNull();
    expect(checkNoShow(consultation, at('2030-01-01T10:11:00Z'))).toBeNull();
  });

  it('enforces the patient cancellation cutoff for confirmed bookings only', () => {
    expect(checkPatientCancel(consultation, 2, at('2030-01-01T07:00:00Z'))).toBeNull();
    expect(checkPatientCancel(consultation, 2, at('2030-01-01T08:30:00Z'))).toMatch(/2 hours/);
    expect(checkPatientCancel({ ...consultation, status: STATUS.PENDING_PAYMENT }, 2, at('2030-01-01T09:59:00Z'))).toBeNull();
  });
});
