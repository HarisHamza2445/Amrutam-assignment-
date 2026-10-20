// Placeholder for the SMS / email / push provider. Kept behind an interface so the real
// one (e.g. MSG91 + SES) can be swapped in from the container without touching callers.
function createLogNotifier({ logger }) {
  return {
    async send({ to, template, data }) {
      logger.info({ to, template, data }, 'notification sent');
    },
  };
}

module.exports = { createLogNotifier };
