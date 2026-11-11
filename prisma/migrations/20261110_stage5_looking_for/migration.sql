-- CreateTable
CREATE TABLE "NeedRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requesterId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "budgetMin" INTEGER NOT NULL,
    "budgetMax" INTEGER NOT NULL,
    "startDate" DATETIME,
    "endDate" DATETIME,
    "rentalDuration" TEXT,
    "desiredCondition" TEXT,
    "specifications" TEXT,
    "subscriptionName" TEXT,
    "desiredPlan" TEXT,
    "desiredDurationDays" INTEGER,
    "seats" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "expiresAt" DATETIME NOT NULL,
    "fulfilledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NeedRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NeedRequest_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NeedOffer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "offererId" TEXT NOT NULL,
    "listingId" TEXT,
    "subscriptionListingId" TEXT,
    "offeredPrice" INTEGER NOT NULL,
    "availableStartDate" DATETIME,
    "availableEndDate" DATETIME,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "condition" TEXT,
    "message" TEXT,
    "terms" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "bookingId" TEXT,
    "purchaseRequestId" TEXT,
    "membershipId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NeedOffer_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "NeedRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NeedOffer_offererId_fkey" FOREIGN KEY ("offererId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NeedOffer_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "NeedOffer_subscriptionListingId_fkey" FOREIGN KEY ("subscriptionListingId") REFERENCES "SubscriptionListing" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "NeedOffer_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "NeedOffer_purchaseRequestId_fkey" FOREIGN KEY ("purchaseRequestId") REFERENCES "PurchaseRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "NeedOffer_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "SubscriptionMembership" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipientId" TEXT NOT NULL,
    "bookingId" TEXT,
    "purchaseRequestId" TEXT,
    "membershipId" TEXT,
    "transactionId" TEXT,
    "conversationId" TEXT,
    "needRequestId" TEXT,
    "needOfferId" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_purchaseRequestId_fkey" FOREIGN KEY ("purchaseRequestId") REFERENCES "PurchaseRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "SubscriptionMembership" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_needRequestId_fkey" FOREIGN KEY ("needRequestId") REFERENCES "NeedRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_needOfferId_fkey" FOREIGN KEY ("needOfferId") REFERENCES "NeedOffer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Notification" ("bookingId", "conversationId", "createdAt", "id", "isRead", "membershipId", "message", "purchaseRequestId", "recipientId", "title", "transactionId") SELECT "bookingId", "conversationId", "createdAt", "id", "isRead", "membershipId", "message", "purchaseRequestId", "recipientId", "title", "transactionId" FROM "Notification";
DROP TABLE "Notification";
ALTER TABLE "new_Notification" RENAME TO "Notification";
CREATE INDEX "Notification_recipientId_isRead_createdAt_idx" ON "Notification"("recipientId", "isRead", "createdAt");
CREATE INDEX "Notification_bookingId_idx" ON "Notification"("bookingId");
CREATE INDEX "Notification_purchaseRequestId_idx" ON "Notification"("purchaseRequestId");
CREATE INDEX "Notification_membershipId_idx" ON "Notification"("membershipId");
CREATE INDEX "Notification_transactionId_idx" ON "Notification"("transactionId");
CREATE INDEX "Notification_conversationId_idx" ON "Notification"("conversationId");
CREATE INDEX "Notification_needRequestId_idx" ON "Notification"("needRequestId");
CREATE INDEX "Notification_needOfferId_idx" ON "Notification"("needOfferId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "NeedRequest_status_requestType_categoryId_createdAt_idx" ON "NeedRequest"("status", "requestType", "categoryId", "createdAt");

-- CreateIndex
CREATE INDEX "NeedRequest_requesterId_status_createdAt_idx" ON "NeedRequest"("requesterId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "NeedRequest_expiresAt_status_idx" ON "NeedRequest"("expiresAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NeedOffer_bookingId_key" ON "NeedOffer"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "NeedOffer_purchaseRequestId_key" ON "NeedOffer"("purchaseRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "NeedOffer_membershipId_key" ON "NeedOffer"("membershipId");

-- CreateIndex
CREATE INDEX "NeedOffer_requestId_status_createdAt_idx" ON "NeedOffer"("requestId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "NeedOffer_offererId_status_createdAt_idx" ON "NeedOffer"("offererId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NeedOffer_requestId_offererId_listingId_key" ON "NeedOffer"("requestId", "offererId", "listingId");

-- CreateIndex
CREATE UNIQUE INDEX "NeedOffer_requestId_offererId_subscriptionListingId_key" ON "NeedOffer"("requestId", "offererId", "subscriptionListingId");

