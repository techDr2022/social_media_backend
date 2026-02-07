/**
 * One-time migration: encrypt existing plaintext accessToken/refreshToken in SocialAccount.
 * - Only encrypts values that do NOT already start with "encrypted:" (safe to run multiple times).
 * - Uses the same algorithm and ENCRYPTION_KEY as EncryptionService.
 *
 * Run from project root (ba/) with .env loaded:
 *   npx ts-node -r tsconfig-paths/register scripts/encrypt-existing-tokens.ts
 * Or: npm run encrypt-tokens
 */
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

const PREFIX = 'encrypted:';
const ALGORITHM = 'aes-256-cbc';
const KEY_LEN = 32;
const IV_LEN = 16;

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    console.warn('.env not found; ensure ENCRYPTION_KEY and DATABASE_URL are set in the environment.');
    return;
  }
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      const val = m[2].replace(/^["']|["']$/g, '').trim();
      process.env[m[1]] = val;
    }
  }
}

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (!raw || raw.length < 16) {
    throw new Error('Set ENCRYPTION_KEY in .env (min 16 chars). Generate with: openssl rand -base64 32');
  }
  return crypto.scryptSync(raw, 'salt', KEY_LEN);
}

function encrypt(plain: string | null | undefined, key: Buffer): string {
  if (plain == null || plain === '') return plain ?? '';
  if (plain.startsWith(PREFIX)) return plain;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const combined = Buffer.concat([iv, enc]);
  return PREFIX + combined.toString('base64');
}

async function main(): Promise<void> {
  loadEnv();
  const key = getKey();
  const prisma = new PrismaClient();

  const accounts = await prisma.socialAccount.findMany({
    select: { id: true, platform: true, accessToken: true, refreshToken: true },
  });

  let updated = 0;
  for (const acc of accounts) {
    const needAccess = acc.accessToken != null && acc.accessToken !== '' && !acc.accessToken.startsWith(PREFIX);
    const needRefresh =
      acc.refreshToken != null && acc.refreshToken !== '' && !acc.refreshToken.startsWith(PREFIX);
    if (!needAccess && !needRefresh) continue;

    await prisma.socialAccount.update({
      where: { id: acc.id },
      data: {
        ...(needAccess && { accessToken: encrypt(acc.accessToken, key) }),
        ...(needRefresh && { refreshToken: encrypt(acc.refreshToken, key) }),
      },
    });
    updated++;
    console.log(`Encrypted tokens for account ${acc.id} (${acc.platform})`);
  }

  console.log(`Done. Updated ${updated} of ${accounts.length} accounts.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
