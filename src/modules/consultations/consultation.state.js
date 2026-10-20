const STATUS = Object.freeze({
  PENDING_PAYMENT: 'pending_payment',
  CONFIRMED: 'confirmed',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  NO_SHOW: 'no_show',
  EXPIRED: 'expired',
});

const TRANSITIONS = {
  [STATUS.PENDING_PAYMENT]: [STATUS.CONFIRMED, STATUS.CANCELLED, STATUS.EXPIRED],
  [STATUS.CONFIRMED]: [STATUS.IN_PROGRESS, STATUS.CANCELLED, STATUS.NO_SHOW],
  [STATUS.IN_PROGRESS]: [STATUS.COMPLETED],
  [STATUS.COMPLETED]: [],
  [STATUS.CANCELLED]: [],
  [STATUS.NO_SHOW]: [],
  [STATUS.EXPIRED]: [],
};

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

// doctor can open the call a little early and until the slot ends
const START_EARLY_MINUTES = 15;
const NO_SHOW_AFTER_MINUTES = 10;

function checkStart(consultation, now = new Date()) {
  const earliest = new Date(consultation.scheduled_start.getTime() - START_EARLY_MINUTES * 60000);
  if (now < earliest) return `Consultation can be started at most ${START_EARLY_MINUTES} minutes early`;
  if (now > consultation.scheduled_end) return 'The scheduled time for this consultation has passed';
  return null;
}

function checkNoShow(consultation, now = new Date()) {
  const allowedFrom = new Date(consultation.scheduled_start.getTime() + NO_SHOW_AFTER_MINUTES * 60000);
  if (now < allowedFrom) return `A no-show can only be marked ${NO_SHOW_AFTER_MINUTES} minutes after the start time`;
  return null;
}

function checkPatientCancel(consultation, cutoffHours, now = new Date()) {
  if (consultation.status !== STATUS.CONFIRMED) return null;
  const cutoff = new Date(consultation.scheduled_start.getTime() - cutoffHours * 3600000);
  if (now > cutoff) return `Confirmed consultations can only be cancelled up to ${cutoffHours} hours before the start`;
  return null;
}

module.exports = { STATUS, TRANSITIONS, canTransition, checkStart, checkNoShow, checkPatientCancel };
