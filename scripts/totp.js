// prints the current TOTP code for a secret - handy for the demo instead of a phone app
const { generateCode } = require('../src/lib/totp');

const secret = process.argv[2];
if (!secret) {
  console.error('usage: npm run totp -- <base32 secret>');
  process.exit(1);
}
console.log(generateCode(secret));
