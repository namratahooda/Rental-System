ALTER TABLE "User" ADD COLUMN "suspended" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Category" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "administratorId" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "beforeStatus" TEXT,
  "afterStatus" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_administratorId_fkey" FOREIGN KEY ("administratorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_administratorId_createdAt_idx" ON "AuditLog"("administratorId", "createdAt");
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

CREATE TABLE "MarketplaceReport" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reporterId" TEXT NOT NULL,
  "reportedUserId" TEXT,
  "listingId" TEXT,
  "subscriptionListingId" TEXT,
  "transactionId" TEXT,
  "reason" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "adminResponse" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "MarketplaceReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MarketplaceReport_reportedUserId_fkey" FOREIGN KEY ("reportedUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "MarketplaceReport_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "MarketplaceReport_subscriptionListingId_fkey" FOREIGN KEY ("subscriptionListingId") REFERENCES "SubscriptionListing" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "MarketplaceReport_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "MarketplaceReport_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "MarketplaceReport_reporterId_createdAt_idx" ON "MarketplaceReport"("reporterId", "createdAt");
CREATE INDEX "MarketplaceReport_status_createdAt_idx" ON "MarketplaceReport"("status", "createdAt");
CREATE INDEX "MarketplaceReport_listingId_idx" ON "MarketplaceReport"("listingId");
CREATE INDEX "MarketplaceReport_reportedUserId_idx" ON "MarketplaceReport"("reportedUserId");
CREATE INDEX "MarketplaceReport_subscriptionListingId_idx" ON "MarketplaceReport"("subscriptionListingId");
CREATE INDEX "MarketplaceReport_transactionId_idx" ON "MarketplaceReport"("transactionId");
