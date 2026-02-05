import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

const PREFIX = 'encrypted:';
const ALGORITHM = 'aes-256-cbc';
const KEY_LEN = 32;
const IV_LEN = 16;

/**
 * Encrypts/decrypts sensitive values (e.g. OAuth tokens) at rest.
 * - No ENCRYPTION_KEY in .env (or < 16 chars): no encryption — store and read plain text.
 * - ENCRYPTION_KEY set (≥ 16 chars): encrypt on write, decrypt on read (values prefixed with "encrypted:").
 */
@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer | null;

  constructor() {
    const raw = process.env.ENCRYPTION_KEY || '';
    if (!raw || raw.length < 16) {
      this.logger.warn('ENCRYPTION_KEY missing or too short. Tokens will be stored in plain text.');
      this.key = null;
    } else {
      this.key = crypto.scryptSync(raw, 'salt', KEY_LEN);
    }
  }

  /** If no key: return plain. If key set and not already encrypted: encrypt and return. */
  encrypt(plain: string | null | undefined): string {
    if (plain == null || plain === '') return plain ?? '';
    if (plain.startsWith(PREFIX)) return plain;
    if (!this.key) return plain;
    try {
      const iv = crypto.randomBytes(IV_LEN);
      const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
      const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const combined = Buffer.concat([iv, enc]);
      return PREFIX + combined.toString('base64');
    } catch (e: any) {
      this.logger.error('Encryption failed: ' + e?.message);
      throw e;
    }
  }

  /** If no key or value not prefixed with "encrypted:": return as-is. Otherwise decrypt. */
  decrypt(cipherText: string | null | undefined): string {
    if (cipherText == null || cipherText === '') return cipherText ?? '';
    if (!cipherText.startsWith(PREFIX)) return cipherText;
    if (!this.key) return cipherText;
    try {
      const raw = Buffer.from(cipherText.slice(PREFIX.length), 'base64');
      const iv = raw.subarray(0, IV_LEN);
      const enc = raw.subarray(IV_LEN);
      const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
      return decipher.update(enc) + decipher.final('utf8');
    } catch (e: any) {
      this.logger.error('Decryption failed: ' + e?.message);
      throw e;
    }
  }
}
