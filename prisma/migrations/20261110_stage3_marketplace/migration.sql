-- CreateTable
CREATE TABLE "PurchaseRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listingId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "originalAmount" INTEGER NOT NULL,
    "agreedAmount" INTEGER NOT NULL,
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

-- CreateTable
CREATE TABLE "PurchaseOffer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "proposedAmount" INTEGER NOT NULL,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" DATETIME,
    CONSTRAINT "PurchaseOffer_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PurchaseRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SubscriptionCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "SubscriptionListing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "totalSeats" INTEGER NOT NULL,
    "availableSeats" INTEGER NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "startDate" DATETIME NOT NULL,
    "expiryDate" DATETIME NOT NULL,
    "pricePerSeat" INTEGER NOT NULL,
    "restrictions" TEXT,
    "terms" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SubscriptionListing_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SubscriptionListing_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "SubscriptionCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SubscriptionMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "startDate" DATETIME NOT NULL,
    "expiryDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SubscriptionMembership_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "SubscriptionListing" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SubscriptionMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "purchaseRequestId" TEXT,
    "membershipId" TEXT,
    "bookingId" TEXT,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'INITIATED',
    "paymentMethod" TEXT NOT NULL DEFAULT 'SIMULATED',
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transaction_purchaseRequestId_fkey" FOREIGN KEY ("purchaseRequestId") REFERENCES "PurchaseRequest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transaction_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "SubscriptionMembership" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transaction_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transactionId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "processedById" TEXT,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    CONSTRAINT "Refund_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Refund_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Refund_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DepositRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "deductionAmount" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "DepositRecord_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewerId" TEXT NOT NULL,
    "reviewedUserId" TEXT NOT NULL,
    "interactionKey" TEXT NOT NULL,
    "transactionId" TEXT,
    "purchaseRequestId" TEXT,
    "bookingId" TEXT,
    "subscriptionMembershipId" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'VISIBLE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Review_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Review_reviewedUserId_fkey" FOREIGN KEY ("reviewedUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Review_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Review_purchaseRequestId_fkey" FOREIGN KEY ("purchaseRequestId") REFERENCES "PurchaseRequest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Review_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Review_subscriptionMembershipId_fkey" FOREIGN KEY ("subscriptionMembershipId") REFERENCES "SubscriptionMembership" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "relatedListingId" TEXT,
    "purchaseRequestId" TEXT,
    "subscriptionListingId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Conversation_relatedListingId_fkey" FOREIGN KEY ("relatedListingId") REFERENCES "Listing" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Conversation_purchaseRequestId_fkey" FOREIGN KEY ("purchaseRequestId") REFERENCES "PurchaseRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Conversation_subscriptionListingId_fkey" FOREIGN KEY ("subscriptionListingId") REFERENCES "SubscriptionListing" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConversationParticipant" (
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("conversationId", "userId"),
    CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConversationParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
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
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_purchaseRequestId_fkey" FOREIGN KEY ("purchaseRequestId") REFERENCES "PurchaseRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "SubscriptionMembership" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Notification" ("bookingId", "createdAt", "id", "isRead", "message", "recipientId", "title") SELECT "bookingId", "createdAt", "id", "isRead", "message", "recipientId", "title" FROM "Notification";
DROP TABLE "Notification";
ALTER TABLE "new_Notification" RENAME TO "Notification";
CREATE INDEX "Notification_recipientId_isRead_createdAt_idx" ON "Notification"("recipientId", "isRead", "createdAt");
CREATE INDEX "Notification_bookingId_idx" ON "Notification"("bookingId");
CREATE INDEX "Notification_purchaseRequestId_idx" ON "Notification"("purchaseRequestId");
CREATE INDEX "Notification_membershipId_idx" ON "Notification"("membershipId");
CREATE INDEX "Notification_transactionId_idx" ON "Notification"("transactionId");
CREATE INDEX "Notification_conversationId_idx" ON "Notification"("conversationId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PurchaseRequest_listingId_status_createdAt_idx" ON "PurchaseRequest"("listingId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseRequest_buyerId_status_createdAt_idx" ON "PurchaseRequest"("buyerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseRequest_sellerId_status_createdAt_idx" ON "PurchaseRequest"("sellerId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequest_buyerId_idempotencyKey_key" ON "PurchaseRequest"("buyerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PurchaseOffer_requestId_createdAt_idx" ON "PurchaseOffer"("requestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionCategory_name_key" ON "SubscriptionCategory"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionCategory_slug_key" ON "SubscriptionCategory"("slug");

-- CreateIndex
CREATE INDEX "SubscriptionListing_status_categoryId_createdAt_idx" ON "SubscriptionListing"("status", "categoryId", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriptionListing_ownerId_status_idx" ON "SubscriptionListing"("ownerId", "status");

-- CreateIndex
CREATE INDEX "SubscriptionListing_expiryDate_idx" ON "SubscriptionListing"("expiryDate");

-- CreateIndex
CREATE INDEX "SubscriptionMembership_userId_status_expiryDate_idx" ON "SubscriptionMembership"("userId", "status", "expiryDate");

-- CreateIndex
CREATE INDEX "SubscriptionMembership_listingId_status_createdAt_idx" ON "SubscriptionMembership"("listingId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionMembership_listingId_userId_key" ON "SubscriptionMembership"("listingId", "userId");

-- CreateIndex
CREATE INDEX "Transaction_userId_status_createdAt_idx" ON "Transaction"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_purchaseRequestId_idx" ON "Transaction"("purchaseRequestId");

-- CreateIndex
CREATE INDEX "Transaction_membershipId_idx" ON "Transaction"("membershipId");

-- CreateIndex
CREATE INDEX "Transaction_bookingId_idx" ON "Transaction"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_userId_idempotencyKey_key" ON "Transaction"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Refund_status_requestedAt_idx" ON "Refund"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "Refund_transactionId_status_idx" ON "Refund"("transactionId", "status");

INSERT OR IGNORE INTO "SubscriptionCategory" ("id", "name", "slug", "active") VALUES
    ('subscription-category-entertainment', 'Entertainment', 'entertainment', true),
    ('subscription-category-ai-productivity', 'AI and Productivity', 'ai-productivity', true),
    ('subscription-category-software-dev', 'Software and Development Tools', 'software-development-tools', true);

-- CreateIndex
CREATE UNIQUE INDEX "DepositRecord_bookingId_key" ON "DepositRecord"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_interactionKey_key" ON "Review"("interactionKey");

-- CreateIndex
CREATE INDEX "Review_reviewedUserId_status_createdAt_idx" ON "Review"("reviewedUserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Review_reviewerId_createdAt_idx" ON "Review"("reviewerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_key_key" ON "Conversation"("key");

-- CreateIndex
CREATE INDEX "Conversation_updatedAt_idx" ON "Conversation"("updatedAt");

-- CreateIndex
CREATE INDEX "ConversationParticipant_userId_joinedAt_idx" ON "ConversationParticipant"("userId", "joinedAt");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_senderId_createdAt_idx" ON "Message"("senderId", "createdAt");
