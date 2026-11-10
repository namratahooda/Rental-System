# Rentol Stage 3 Completion Audit

Audit date: 10 November 2026

## PASS — implemented and verified

### Subscription membership lifecycle and seat allocation

- **Finding:** A seat request creates one `SubscriptionMembership`; owner approval updates that row to `APPROVED`, checkout moves it through `PAYMENT_PENDING`, and successful simulated payment updates it to `ACTIVE`. The schema enforces `@@unique([listingId, userId])`. The request API rejects repeat pending or active requests and reuses the same row after a rejected or cancelled attempt.
- **Database/API impact:** No schema change was needed. The existing database query returned zero duplicate `(listingId, userId)` groups and two active membership rows. No existing records were deleted or changed during the audit.
- **Fixes:** Seat-count edits now count allocated memberships and update `availableSeats` inside a transaction. Rejection and cancellation transitions are conditional; cancellation releases a reserved seat only once. Expiry processing remains guarded by a conditional `ACTIVE` transition and releases the seat in the same transaction.
- **Files:** `prisma/schema.prisma`, `server/marketplace-routes.js`, `src/Stage3.jsx`.
- **Tests:** Duplicate pending/active request, repeat approval, concurrent approval for one available seat, failed payment release, cancellation release-once, successful payment repeated twice, and membership history persistence.
- **Result:** Passed in `npm run test:stage3`.

### Subscription review eligibility

- **Finding:** The prior API and membership page allowed a member to review while the subscription was still active. That did not meet the completed-interaction rule.
- **Fix:** Reviews are now allowed only once the membership period has ended. The API runs expiry processing before checking eligibility, and the form is shown only for `EXPIRED` memberships. Review history includes the related subscription membership. Self-review checks, 1–5 rating validation, unique interaction keys, public visible-review averages, and recipient review notifications are enforced.
- **Files:** `server/marketplace-routes.js`, `src/Stage3.jsx`, `server/marketplace-api.test.js`.
- **Tests:** Active membership review rejected; expired membership review accepted and shown in history; duplicate review rejected; rating bounds and public summary checked.
- **Result:** Passed in `npm run test:stage3`.

### Used-item purchase workflow

- **Finding:** The request, seller decision, buyer offer, seller response, server-calculated agreed amount, simulated checkout, inventory decrement, Sold status, buyer/seller history and notifications are connected end to end.
- **Fix:** When a payment sells out the listing, remaining pending, accepted or payment-pending requests are rejected, their initiated transactions are cancelled, and affected buyers are notified. Removed a second seller notification that duplicated the sale-completion event.
- **Files:** `server/marketplace-routes.js`, `src/Stage3.jsx`, `server/marketplace-api.test.js`.
- **Tests:** Seller authorization, proposal acceptance and price persistence, client amount manipulation, successful/failed/cancelled payment, repeated success confirmation, sold listing protection, seller/buyer history, one-unit concurrent acceptance, and notification delivery.
- **Result:** Passed in `npm run test:stage3`.

### Simulated transactions and refunds

- **Finding:** Transaction records are created with server-derived amounts, tied to the payer and purchase or membership, and persisted in transaction history. Only the payer can resolve checkout; related sellers may inspect received records. Failed or cancelled outcomes do not complete a purchase or activate a membership. Repeating a completed outcome returns the same transaction.
- **Refund workflow:** The payer’s reason and amount are stored; cumulative pending, approved and processed refunds cannot exceed the transaction amount. Related listing owners and administrators can approve, reject with a required reason, and mark approved refunds processed. The requester cannot review their own request. Approval/rejection actors and timestamps are stored separately from processing details, transaction states are recalculated after rejection or processing, and requesters receive notifications for each decision.
- **Files:** `prisma/schema.prisma`, `prisma/migrations/20261110_stage3_refund_review/migration.sql`, `server/apply-stage3-migration.js`, `server/marketplace-routes.js`, `src/Stage3.jsx`, `src/stage3.css`, `server/marketplace-api.test.js`.
- **Tests:** Transaction owner/outsider access, seller-only inspection, payer-only resolution, amount tampering, payment outcomes and idempotency, owner/admin refund authorization, requester self-review denial, refund limits, approval/rejection/processing metadata, partial refunds, rejected/duplicate processing, notifications, and refreshed transaction history.
- **Result:** Passed in `npm run test:stage3`.

### Messaging and notifications

- **Finding:** Conversations are keyed uniquely by context and participant pair; messages persist, derive their sender from the session, and are visible only to participants. Read timestamps persist and unread counts are recalculated after reading. Notifications are recipient-scoped by the API.
- **Fixes:** Concurrent duplicate conversation creation now returns the existing conversation when the unique key wins the race. The conversation page reloads messages after marking them read so the displayed read state is current. Marketplace actions refresh the notification bell. The notifications page now describes all marketplace activity, not rentals alone.
- **Files:** `server/marketplace-routes.js`, `server/booking-routes.js`, `src/App.jsx`, `src/Stage3.jsx`, `server/marketplace-api.test.js`.
- **Tests:** Conversation reuse, outsider access denial, sender spoofing, message persistence, unread count/read state, notification ownership, and purchase/payment/review/message notification delivery.
- **Result:** Passed in `npm run test:stage3`.

### Earlier-stage regression

- **Finding:** The Stage 1 registration and external-access approval checks and Stage 2 rental lifecycle, availability, bargaining, return and notification checks remain operational in the existing suites.
- **Files:** Existing Stage 1 and Stage 2 implementation; regression suites `server/booking-api.test.js` and related domain tests.
- **Tests:** `npm run test:stage2` — 20 passed, 0 failed. Stage 3 runner also reruns these checks.
- **Result:** Passed.

## PARTIAL — implementation passes, verification is limited

### Browser-level dashboard workflows

- **Root cause:** The available verification ran API integration tests and the production build; it did not drive a browser session with separate buyer, seller, member and administrator accounts.
- **Impact:** Dashboard records, loading/empty/error states, status labels, navigation and responsive presentation have not been manually observed in a browser. API routes and frontend component wiring were inspected, and loading states/read refresh behavior were corrected.
- **Files:** `src/App.jsx`, `src/Stage3.jsx`, `src/stage3.css`.
- **Tests:** API suites and `npm run build` passed; manual browser checks were not run.
- **Result:** No browser-only defect was established; visual interaction verification remains outstanding.

### Full Stage 1 listing/admin regression coverage

- **Root cause:** Current automated regression suites cover authentication and external access approval but do not exercise every Stage 1 search/filter, wishlist and administrator dashboard action.
- **Impact:** Those paths were inspected for compatibility but are not claimed as fully regression-tested in this audit.
- **Files:** Stage 1 listing/dashboard code in `src/App.jsx` and API routes in `server/index.js`.
- **Tests:** `npm run test:stage2` passed; no dedicated Stage 1 search/wishlist/admin suite was run.
- **Result:** No Stage 1 regression was observed; coverage remains partial.

## FAIL

No currently observed Stage 3 backend/API failure remains after the fixes above.

## Verification summary

- `npm run test:stage3`: 28 passed, 0 failed.
- `npm run test:stage2`: 20 passed, 0 failed.
- `npx prisma validate`: passed.
- `npm run build`: passed (Vite production build).
- Configured database inspection: 0 duplicate membership groups; 2 active membership rows. Existing records were preserved.
- No real payment processing was added; checkout and refunds remain explicitly simulated.

## Verdict

**Stage 3 Complete with Minor Issues.** The implemented API workflows pass integration tests and the production build succeeds. Browser-level user-flow checks and broader Stage 1 search/wishlist/administrator regression tests remain unverified.
