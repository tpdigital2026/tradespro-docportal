/**
 * Length of the emailed sign-in code. It must match the Supabase Auth setting (the default is 8
 * digits). The UI, the verify route and the tests all read this one constant.
 */
export const OTP_LENGTH = 8;

/** Placeholder boxes for the code field, one zero per digit. */
export const OTP_PLACEHOLDER = '0'.repeat(OTP_LENGTH);

export const OTP_PATTERN = new RegExp(`^\\d{${OTP_LENGTH}}$`);
