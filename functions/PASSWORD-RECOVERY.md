# Password recovery

Deploy hosting, Cloud Functions, Firestore rules and Storage rules together. New callables: findRecoveryAccount, sendRecoveryCode, verifyRecoveryCode, resetRecoveryPassword. Uses existing SENDGRID_API_KEY and EMAIL_OTP_HMAC_KEY secrets and the configured SendGrid sender.

Email is the available delivery channel. SMS/messaging require a configured provider and verified destination ownership; phone numbers currently identify accounts only. Usernames match existing users.username exactly. Registration currently does not collect usernames. Phone lookup supports stored exact values and common Philippine local/international formats. Duplicate phone matches require email.

Passwords are updated through Firebase Authentication, never stored in Firestore. Codes and grants are HMAC-protected, expiring and single-use. Five code attempts, one email per minute and five per hour per account; lookup limited to 20 per hour per IP. Account results are masked. Configure Firestore TTL on expiresAt in _password_recovery and _recovery_limits. Session revocation metadata must be retained.

Reset revokes Firebase refresh tokens; rules and authenticated callable checks reject older sessions. Open clients refresh tokens every minute and on focus. Cached data already downloaded cannot be recalled. See https://firebase.google.com/docs/auth/admin/manage-sessions .

Before production: deploy and validate email delivery, both-device logout, rules with Firebase emulators, expired/wrong codes, resend, password policy and mobile layout. No live deployment or provider delivery test was performed locally.
