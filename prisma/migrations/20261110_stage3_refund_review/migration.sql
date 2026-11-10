-- Persist review decisions separately from simulated refund processing.
ALTER TABLE "Refund" ADD COLUMN "approvedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD COLUMN "approvedAt" DATETIME;
ALTER TABLE "Refund" ADD COLUMN "rejectedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD COLUMN "rejectedAt" DATETIME;
ALTER TABLE "Refund" ADD COLUMN "rejectionReason" TEXT;
