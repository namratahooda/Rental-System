import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { prisma } from './db.js';

const migrations = ['20261110_stage3_marketplace', '20261110_stage3_refunds', '20261110_stage3_refund_review'];

try {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "_RentolMigration" ("id" TEXT NOT NULL PRIMARY KEY, "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    for (const migrationId of migrations) {
      const [applied] = await tx.$queryRawUnsafe('SELECT "id" FROM "_RentolMigration" WHERE "id" = ?', migrationId);
      if (applied) continue;
      if (migrationId === '20261110_stage3_refunds') {
        const indexes = await tx.$queryRawUnsafe('PRAGMA index_list("Refund")');
        if (indexes.some((index) => index.name === 'Refund_transactionId_key')) {
          await tx.$executeRawUnsafe('DROP INDEX "Refund_transactionId_key"');
        }
      }
      const migrationPath = resolve(dirname(fileURLToPath(import.meta.url)), `../prisma/migrations/${migrationId}/migration.sql`);
      const sql = await readFile(migrationPath, 'utf8');
      const statements = sql.split(';').map((statement) => statement.trim()).filter(Boolean);
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
      await tx.$executeRawUnsafe('INSERT INTO "_RentolMigration" ("id") VALUES (?)', migrationId);
    }
  });
  console.log(`Applied Stage 3 migrations without resetting existing Rentol data.`);
} finally {
  await prisma.$disconnect();
}
