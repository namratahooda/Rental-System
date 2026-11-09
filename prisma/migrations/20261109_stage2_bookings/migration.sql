CREATE TABLE IF NOT EXISTS "_RentolMigration" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Booking" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "listingId" TEXT NOT NULL,
  "renterId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "startDate" DATETIME NOT NULL,
  "endDate" DATETIME NOT NULL,
  "quantity" INTEGER NOT NULL,
  "priceUnit" TEXT NOT NULL,
  "rentalUnits" INTEGER NOT NULL,
  "originalAmount" INTEGER NOT NULL,
  "agreedAmount" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "renterMessage" TEXT,
  "idempotencyKey" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "approvedAt" DATETIME,
  "completedAt" DATETIME,
  FOREIGN KEY ("listingId") REFERENCES "Listing" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("renterId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Booking_renterId_idempotencyKey_key" ON "Booking" ("renterId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "Booking_listingId_status_startDate_endDate_idx" ON "Booking" ("listingId", "status", "startDate", "endDate");
CREATE INDEX IF NOT EXISTS "Booking_renterId_status_createdAt_idx" ON "Booking" ("renterId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "Booking_ownerId_status_createdAt_idx" ON "Booking" ("ownerId", "status", "createdAt");

CREATE TABLE IF NOT EXISTS "Negotiation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "bookingId" TEXT NOT NULL,
  "proposedDiscountPercentage" INTEGER NOT NULL,
  "proposedAmount" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "message" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "respondedAt" DATETIME,
  FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Negotiation_bookingId_key" ON "Negotiation" ("bookingId");
CREATE INDEX IF NOT EXISTS "Negotiation_status_createdAt_idx" ON "Negotiation" ("status", "createdAt");

CREATE TABLE IF NOT EXISTS "Notification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "recipientId" TEXT NOT NULL,
  "bookingId" TEXT,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "isRead" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("recipientId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "Notification_recipientId_isRead_createdAt_idx" ON "Notification" ("recipientId", "isRead", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_bookingId_idx" ON "Notification" ("bookingId");
