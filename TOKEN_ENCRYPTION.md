# Token encryption (backward‑compatible)

## How we avoid affecting old tokens

1. **Read path (decrypt)**  
   When the app reads `accessToken` or `refreshToken` from the DB:
   - If the value **starts with `"encrypted:"`** → it is decrypted and the plain token is used.
   - If it **does not** (legacy plaintext) → it is **returned as-is**. No change, no error.

2. **Write path (encrypt)**  
   When the app saves tokens (OAuth callback, refresh, etc.):
   - Values are encrypted and stored with the `"encrypted:"` prefix.
   - If a value already starts with `"encrypted:"`, it is not encrypted again.

3. **Migration script**  
   The one-time script only updates rows where the token **does not** start with `"encrypted:"`.  
   So:
   - Old (plaintext) tokens keep working until you run the script.
   - You can run the script once to encrypt all existing plaintext tokens.
   - Running the script multiple times is safe (already-encrypted rows are skipped).

So **old accounts keep working** before and after you add encryption; the migration just converts existing plaintext to encrypted form when you choose to run it.

## Setup and migration

1. **Set a key in `.env`** (min 16 characters; e.g. 32-byte base64):
   ```bash
   # Generate a key:
   openssl rand -base64 32
   # Add to .env:
   ENCRYPTION_KEY=<paste-the-generated-key>
   ```

2. **Restart the app** so it uses `ENCRYPTION_KEY`. New and updated tokens will be stored encrypted.

3. **Optional one-time migration** (encrypt existing plaintext tokens in the DB):
   ```bash
   cd ba
   npm run encrypt-tokens
   ```
   Safe to run multiple times; only plaintext tokens are updated.

## Reference

- Encryption: `src/common/encryption.service.ts`
- Migration script: `scripts/encrypt-existing-tokens.ts`
- `.env.example` documents `ENCRYPTION_KEY`.
