-- Permit multiple partial refund requests for one transaction.
-- The migration runner conditionally replaces the old unique transactionId index.
CREATE INDEX IF NOT EXISTS "Refund_transactionId_status_idx" ON "Refund"("transactionId", "status");
