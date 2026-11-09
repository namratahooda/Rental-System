import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const filename = `stage2-test-${process.pid}.db`;
const databaseFile = join(root, 'prisma', filename);
const databaseUrl = `file:./${filename}`;
const childEnv = { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' };
const sourcePrisma = new PrismaClient();
let exitCode = 1;

try {
  await sourcePrisma.$queryRawUnsafe('PRAGMA wal_checkpoint(FULL)');
  const databases = await sourcePrisma.$queryRawUnsafe('PRAGMA database_list');
  const sourceFile = databases.find((entry) => entry.name === 'main')?.file;
  if (!sourceFile || !existsSync(sourceFile)) throw new Error('Could not find the configured SQLite database. Run npm run db:stage2 first.');
  await sourcePrisma.$disconnect();
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    const path = databaseFile + suffix;
    if (existsSync(path)) rmSync(path, { force: true });
  }
  copyFileSync(sourceFile, databaseFile);
  const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'server/email-policy.test.js', 'server/booking-domain.test.js', 'server/booking-api.test.js'], { cwd: root, env: childEnv, stdio: 'inherit' });
  exitCode = run.status ?? 1;
} catch (error) {
  console.error(error.message);
} finally {
  await sourcePrisma.$disconnect();
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    const path = databaseFile + suffix;
    if (existsSync(path)) rmSync(path, { force: true });
  }
}
process.exitCode = exitCode;
