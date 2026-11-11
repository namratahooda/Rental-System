-- AlterTable
ALTER TABLE "NeedRequest" ADD COLUMN "expiryNoticeSentAt" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PurchaseRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listingId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "originalAmount" INTEGER NOT NULL,
    "agreedAmount" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "offerCount" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PurchaseRequest_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseRequest_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseRequest_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PurchaseRequest" ("agreedAmount", "buyerId", "createdAt", "id", "idempotencyKey", "listingId", "message", "offerCount", "originalAmount", "sellerId", "status", "updatedAt") SELECT "agreedAmount", "buyerId", "createdAt", "id", "idempotencyKey", "listingId", "message", "offerCount", "originalAmount", "sellerId", "status", "updatedAt" FROM "PurchaseRequest";
DROP TABLE "PurchaseRequest";
ALTER TABLE "new_PurchaseRequest" RENAME TO "PurchaseRequest";
CREATE INDEX "PurchaseRequest_listingId_status_createdAt_idx" ON "PurchaseRequest"("listingId", "status", "createdAt");
CREATE INDEX "PurchaseRequest_buyerId_status_createdAt_idx" ON "PurchaseRequest"("buyerId", "status", "createdAt");
CREATE INDEX "PurchaseRequest_sellerId_status_createdAt_idx" ON "PurchaseRequest"("sellerId", "status", "createdAt");
CREATE UNIQUE INDEX "PurchaseRequest_buyerId_idempotencyKey_key" ON "PurchaseRequest"("buyerId", "idempotencyKey");
CREATE TABLE "new_SubscriptionMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "seatCount" INTEGER NOT NULL DEFAULT 1,
    "startDate" DATETIME NOT NULL,
    "expiryDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SubscriptionMembership_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "SubscriptionListing" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SubscriptionMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SubscriptionMembership" ("amount", "createdAt", "expiryDate", "id", "listingId", "message", "startDate", "status", "updatedAt", "userId") SELECT "amount", "createdAt", "expiryDate", "id", "listingId", "message", "startDate", "status", "updatedAt", "userId" FROM "SubscriptionMembership";
DROP TABLE "SubscriptionMembership";
ALTER TABLE "new_SubscriptionMembership" RENAME TO "SubscriptionMembership";
CREATE INDEX "SubscriptionMembership_userId_status_expiryDate_idx" ON "SubscriptionMembership"("userId", "status", "expiryDate");
CREATE INDEX "SubscriptionMembership_listingId_status_createdAt_idx" ON "SubscriptionMembership"("listingId", "status", "createdAt");
CREATE UNIQUE INDEX "SubscriptionMembership_listingId_userId_key" ON "SubscriptionMembership"("listingId", "userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

