# Rentol

Rentol is a campus marketplace for renting, reselling, subscription sharing and campus transactions within IIIT Allahabad. Stages 1–3 are implemented.

## Requirements

- Node.js 20 or newer
- npm

## Run locally

1. Copy `.env.example` to `.env` only if you do not already have a local `.env`. The server admits only valid addresses ending exactly in `@iiita.ac.in`; this rule is enforced in backend code and is not configurable through `.env`.
2. To enable Google sign-in, create an OAuth 2.0 Web client in Google Cloud. Add the callback URI from `GOOGLE_CALLBACK_URL` (default `http://localhost:4000/api/auth/google/callback`) to its authorized redirect URIs, then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. Google sign-in accepts verified campus accounts directly; other domains enter the existing administrator approval flow.
3. Install dependencies: `npm install`
4. Create the SQLite database: `npm run db:push`
5. Add the marketplace categories: `npm run db:seed`
6. Apply the additive Stage 2 rental tables: `npm run db:stage2`
7. Apply the additive Stage 3 marketplace tables: `npm run db:stage3`
8. Start the frontend and API: `npm run dev`
9. Open <http://localhost:5173>.

Public registration always creates a student account. To promote an existing approved account, run `npm run admin:promote -- user@iiita.ac.in`. For initial local setup, `npm run admin:create -- admin@example.com` creates a separate approved administrator account and prompts for its password without echoing it; this command is for trusted project operators only.

The API runs on port 4000. The Vite development server proxies `/api` requests. In production, serve the built frontend and API behind the same origin.

## Stage 1 scope

- Campus-domain registration and login, password hashing, sessions, profile editing, and administrator authorization.
- External-email access requests collect college and reason, remain pending for review, and can be approved or rejected by an administrator.
- Google sign-in follows the same domain and approval rules. External Google accounts complete a college/reason request before an access request is created.
- RENT listings support daily, monthly or both price models; SELL listings have a separate fixed price. Both support photos, editing, deletion and pause/publish.
- Rent and Sell pages use database-backed search, category, price and condition filters, sorting, and loading/empty/error states.
- Authenticated wishlist, student listing/rental/sale totals, and an administrator overview with user, access request and listing statistics.
- Subscriptions are hidden and blocked from Stage 1 listings. Only the eight Stage 1 categories are exposed.

Listing images can be uploaded as up to five images (700 KB each) and are stored in SQLite.

## Stage 2: rental booking management

Rental detail pages include date selection, a month calendar, quantity selection, daily or monthly price estimates, and an optional 10%, 15%, or 20% discount proposal. Monthly billing counts each started 30-day period. The end date is an exclusive checkout date, so the number of rental days is the date difference. Amounts are calculated and saved by the server in whole INR; percentage proposals are rounded to the nearest rupee.

Pending requests appear on the calendar but do not reserve stock. Approved and active rentals reserve their requested quantities for overlapping dates. Owners recheck inventory when approving; simultaneous conflicting approvals cannot both succeed. An approved request can be cancelled by its renter before its start date. Owners mark a rental active at handoff and confirm its return to complete it. Notifications are stored in SQLite and are visible only to their recipient.

Use the calendar and bell icons in the top navigation to open **Rental management** and **Notifications**. Rental management includes renter requests, owner requests, active rentals, and history. Owners respond to any discount proposal before approving the related request.

Booking API routes are mounted under `/api`:

- `GET /listings/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `POST /booking-key` (authenticated; returns a server-generated idempotency key)
- `POST /listings/:id/bookings` with the returned `Idempotency-Key`
- `GET /bookings` and `GET /bookings/:id`
- `POST /bookings/:id/approve`, `/reject`, `/cancel`, `/activate`, and `/complete`
- `POST /bookings/:id/negotiations` and `PATCH /bookings/:id/negotiation`
- `GET /notifications`, `PATCH /notifications/:id/read`, and `PATCH /notifications/read-all`

All booking status, authorization, availability, quantity and price checks run in the API. Booking details are restricted to the renter, listing owner, or administrator. Notification reads are restricted to their recipient.

The migration at `prisma/migrations/20261109_stage2_bookings/migration.sql` only creates new booking, negotiation, and notification tables and indexes. Run `npm run db:stage2` after the existing Stage 1 database has been created. It records the migration in `_RentolMigration`; it does not reset or rewrite Stage 1 rows. Keep a database backup before applying schema changes to an important deployment.

Run the regression suite with `npm run test:stage2`. It creates a temporary copy of the configured SQLite database, runs the API and domain tests against that copy, then removes the copy and test fixtures.

### Manual renter and owner checks

1. Sign in as a renter, open an active Rent listing, pick available dates and quantity, and submit a request with or without a discount proposal.
2. Sign in as the listing owner. Use the calendar icon to review the incoming request, respond to any proposal, then approve or reject it.
3. Sign back in as the renter and inspect the status and notifications. An approved request can be cancelled before its start date.
4. On or after the start date, the owner marks the item handed over. After the return, the owner confirms it; the completed request remains in rental history.

## Stage 3: advanced marketplace and transactions

Sell listings support buyer purchase requests, buyer price offers and seller responses. An accepted purchase is completed only after a successful simulated checkout. Checkout amounts are calculated by the server from the agreed price; clients cannot set a payment amount. Completing a sale updates inventory and marks a zero-stock listing Sold. A sold listing cannot be republished.

Subscription sharing has configurable categories, owner listings, seat requests, owner approval, simulated checkout, membership expiry and seat release. Owners can manage their plans from the Subscriptions dashboard. Administrators can add or deactivate categories through `POST /api/admin/subscription-categories` and `PATCH /api/admin/subscription-categories/:id`.

The dashboard includes Purchases, Subscriptions, Transactions & refunds, Conversations and Reviews. Refund requests are capped at the amount paid; administrators approve, reject or mark the simulated refund processed. Reviews are limited to completed purchase, membership or rental interactions and administrators can hide or restore them. Private conversations are available between listing or subscription participants. Notifications remain recipient-private.

All payment flows are demonstrations stored as transaction records. Rentol does not process money and checkout must not collect payment credentials. Real payment-provider integration, external messaging, email/SMS delivery and dispute handling are out of scope.

Apply Stage 3 after Stage 2 with `npm run db:stage3`. The migration runner applies additive schema changes and supports upgrading the existing one-refund-per-transaction schema to multiple partial refunds without resetting existing Rentol data. Run `npm run test:stage3` for the Stage 1/2 regression and Stage 3 API suites; test data is isolated in a temporary database copy. Run `npm run build` to create the production frontend bundle.

### Manual Stage 3 checks

1. Create a Sell listing as one account, then make a purchase request as another account. Test a price proposal and seller response, and complete checkout using each simulated outcome.
2. Create a subscription plan, request a seat as another user, approve it as the owner, and test successful, failed and cancelled checkout. Verify seat availability after cancellation and expiry.
3. Open Transactions & refunds to request a partial refund; use an admin account to approve and mark it processed. Review the transaction status and remaining refundable amount.
4. Start a conversation from a listing or subscription, send a message from each account, and confirm a third account cannot access it.
5. Submit a review only after a completed interaction; verify it appears in the owner’s public review summary and can be hidden by an administrator.

## Notes

Sessions are held in the server process memory and expire after seven days; restart clears active sessions. Use HTTPS and a durable session store before deploying. Google OAuth requires a configured Web client and exact redirect URI. No email verification or login-attempt rate limiting is included, as specified for Stage 1. The current SQLite and in-memory session setup is intended for a single local API instance; move to a shared transactional database and durable session store before running multiple production instances.
