import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { prisma } from './db.js';

const migrationId = '20261109_stage2_bookings';
const migrationPath = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma/migrations/20261109_stage2_bookings/migration.sql');
const sql = await readFile(migrationPath, 'utf8');
const statements = sql.split(';').map((statement) => statement.trim()).filter(Boolean);

try {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "_RentolMigration" ("id" TEXT NOT NULL PRIMARY KEY, "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const [applied] = await tx.$queryRawUnsafe('SELECT "id" FROM "_RentolMigration" WHERE "id" = ?', migrationId);
    if (applied) return;
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
    await tx.$executeRawUnsafe('INSERT INTO "_RentolMigration" ("id") VALUES (?)', migrationId);
  });
  console.log(`Applied ${migrationId} without modifying existing Stage 1 rows.`);
} finally {
  await prisma.$disconnect();
}
