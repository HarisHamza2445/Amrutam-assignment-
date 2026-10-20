const { z } = require('zod');

const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), 'Password needs upper case, lower case and a number');

const email = z.email().max(254).transform((v) => v.toLowerCase());
const code = z.string().regex(/^\d{6}$/, 'Code must be 6 digits');

module.exports = {
  register: z.object({
    email,
    password,
    fullName: z.string().trim().min(2).max(100),
    role: z.enum(['patient', 'doctor']).default('patient'),
  }),
  login: z.object({ email, password: z.string().min(1).max(128) }),
  loginMfa: z.object({ mfaToken: z.string().min(1), code }),
  refresh: z.object({ refreshToken: z.string().min(20).max(200) }),
  mfaCode: z.object({ code }),
};
