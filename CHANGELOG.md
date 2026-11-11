# Changelog

## Stage 4 — administration and release preparation

- Added central administrator console, user activity details, external access review, account suspension/reactivation, listing moderation and category controls.
- Added rental, purchase/subscription, simulated transaction/refund, report and administrator audit views.
- Added private listing/user/subscription/transaction reports with an administrator resolution workflow and reporter notifications.
- Added database-backed range-filtered analytics, including category/type summaries and activity time series. Metrics label simulated amounts and state their active-user definition.
- Added additive Prisma/SQLite migration, isolated Stage 4 API tests and updated setup, admin, deployment, maintenance and traceability documentation.
- Added startup validation for SQLite database URL, listener port, production HTTPS origin and paired Google OAuth configuration.
- Fixed suspension to preserve access approval, safe analytics JSON serialization, and test fixture cleanup for new audit foreign keys.

## 1.0.0 — Stage 1 foundation

- Added responsive campus marketplace, category browsing, listing detail, dashboard and account screens.
- Added SQLite/Prisma models for users, roles, external access requests, categories, listings, images and wishlists.
- Added password hashing, cookie-based sessions, exact institutional-domain handling, external access review and admin authorization.
- Restricted direct institutional access to `@iiita.ac.in` and added Google OAuth sign-in with state/PKCE validation and the same external-email approval policy.
- Added RENT/SELL listing management, search/filter/sorting, wishlist and basic administrator user/listing controls.
- Added setup documentation and environment example.

## Stage 1 audit fixes

- External access requests now require college affiliation and a reason; administrators can see the submitted college.
- New Google external users complete the same college/reason request before remaining pending for admin approval.
- Hid and blocked the Stage 3 Subscriptions category from marketplace browsing and listing forms.
- Added Daily, Monthly and Both rental pricing modes, correct monthly-only card pricing, and matching server-side validation on edits.
- Added marketplace error/loading/empty states, student rent/sale totals, and an administrator statistics overview.
- Prevented reactivation controls from bypassing pending or rejected external access decisions and hid paused listings from other users.

## Authentication rule hardening

- Normalize email with trim/lowercase and admit direct institutional registration only when the complete domain equals `iiita.ac.in`.
- Ensure public password and Google registration always create student-role accounts; added a local CLI promotion command for approved accounts.

## Stage 2 — Rental bookings

- Added an availability calendar, date/quantity booking requests, server-side price snapshots, and idempotent request handling.
- Added owner approval/rejection, renter cancellation, active/completed rental lifecycle, structured 10/15/20 percent proposals, and return history.
- Added private database-backed notifications and rental-management/notification pages.
- Added a non-destructive SQLite migration, a temporary-copy API test runner, and `node:test` domain/API coverage.
