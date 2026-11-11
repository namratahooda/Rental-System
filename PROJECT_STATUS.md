# Rentol Project Status — Looking For feature (Stages 1–6)

## Summary

Stages 1–4 are implemented against SQLite/Prisma for the local application. Stage 4 adds an administrator console, reporting, audit history, account suspension, operational oversight and database-backed analytics while retaining the existing Rentol design. The project is not deployed to a public host.

## Completed

- Institutional email/password registration and login, bcrypt password hashing, HTTP-only session cookies, profile editing and role-protected admin APIs.
- The institutional domain is fixed to the exact `iiita.ac.in` domain. Addresses are trimmed and lowercased; only the complete domain after `@` qualifies for direct access. Public registration always creates a student role, and administrator access is granted separately to an existing approved user.
- External access requests collect name, email, college and reason. Pending and rejected users cannot access protected features; approved users can log in.
- Google OAuth authorization-code flow with state and PKCE. Verified `@iiita.ac.in` identities are admitted directly. External Google identities must submit college and reason, then remain pending for admin review.
- Database-backed Rent and Sell browsing, details, multiple images, owner information, daily/monthly/both rent prices, fixed sale prices, category/search/price/condition filters and sorting.
- Owner listing creation, editing, deletion and pause/publish with ownership validation. Paused and removed listings are hidden from other users.
- Persistent, duplicate-safe wishlist with user ownership enforcement.
- Student dashboard with profile, listing management, wishlist, rental/sale totals and quick add action.
- Administrator overview statistics, access review, user suspension/reactivation, listing moderation and server-side role checks.
- Local-only administrator account creation and promotion commands; public registration cannot grant the administrator role.
- Stage 3 purchase requests, simulated transactions/refunds, subscriptions, seat memberships, reviews and private conversations.
- Stage 2 booking calendar, booking requests, owner approval/rejection, status lifecycle, structured discount proposals, database-backed notifications, rental history and return confirmation.
- Looking For reverse marketplace for rent, buy and subscription requests, with private offers, expiry, notifications and transactional handoff into the existing booking, purchase and membership flows.

## Verification

- `npm run build` — passed.
- `npm exec prisma validate` — passed.
- `node --check server/index.js` — passed.
- `npm run test:auth-domain` — 2 permanent unit tests passed for exact-domain normalization and rejection of external/lookalike domains.
- Institutional-domain API smoke harness — 22 assertions passed: direct institutional registration and protected access, pending external registration/login/API restrictions for Gmail, Outlook, fake and nested domains, public-role escalation prevention, immutable email, administrator approval and subsequent login. Temporary users and harness file were removed.
- Temporary API smoke harness — 47 assertions passed for institutional registration, external approval/rejection, listing CRUD and visibility, monthly price filtering, wishlist persistence, admin management and ordinary-user authorization. Temporary users and harness file were removed.
- Google external-request endpoint without its short-lived OAuth challenge returns 401. A real Google consent/token exchange was not run as part of this audit.
- `npm run test:stage2` — 20 tests passed, including API authorization, date/quantity validation, pending and approved availability, concurrent approval, price proposals, lifecycle transitions, notification privacy/read persistence, and Stage 1 registration/access approval regressions. Tests run against a temporary copy of the configured SQLite database.
- `npm run build` — passed with the Stage 2 frontend.
- `node --check` — passed for the Stage 2 server modules.

## Database and API changes

- No Prisma schema migration was required; the existing User college, role, access-request, listing, image and wishlist models support the audited workflows.
- Category API and marketplace queries hide `subscriptions`; the seed list no longer adds it. An old category row, if already present in SQLite, is retained but not exposed or accepted for new listings.
- Added `GET /api/admin/stats`, and temporary Google external-request metadata/form endpoints protected by a short-lived HttpOnly challenge cookie.
- Listing create/edit now enforce the price fields implied by listing type and reject unavailable categories. Admin user reactivation cannot override pending or rejected access requests.
- Added `Booking`, `Negotiation`, and `Notification` Prisma models, plus additive SQL migration `prisma/migrations/20261109_stage2_bookings/migration.sql`.
- Applied the additive migration to the configured local SQLite database with `npm run db:stage2`; it creates new tables/indexes and leaves Stage 1 tables and rows unchanged. A pre-migration database backup was created in the system temporary directory.
- Added the authenticated booking, negotiation and notification API routes in `server/booking-routes.js`. The detailed endpoint list and date/price policy are documented in the README.

## Known issues and technical debt

- Sessions and short-lived Google external-request challenges are in memory; a server restart clears them. Use a durable session/challenge store before deployment.
- Uploaded image data is stored in SQLite. This is suitable for the current local Stage 1, but a production deployment should move image bytes to object storage.
- The full Google sign-in round trip requires valid Google Cloud Web client credentials and its registered callback URI. The code path was inspected and its local state/PKCE behavior was smoke-checked, but provider consent was not completed during this audit.
- Responsive breakpoints are implemented in CSS and the production bundle builds; a browser-based visual pass at phone/tablet sizes remains advisable.
- Prisma's `db push` schema engine returned an empty schema-engine error even with a disposable database, so the additive Stage 2 SQL migration is applied with `npm run db:stage2`. Do not use `db push` to apply this migration on the current local environment.
- The UI was verified with a production build, but not with a browser-based visual pass at phone/tablet sizes.

## Stage 2 readiness

Core Stage 1 and Stage 2 API workflows pass. Before deployment or a public launch, configure and perform a live Google OAuth login, visually inspect the responsive UI, and move sessions and images to durable production services. Rental bookings currently use SQLite and server-local sessions; do not run multiple API instances with SQLite for concurrent production booking traffic without moving to a database with robust cross-process transaction handling.

## Stage 4 additions and verification

- Central `/admin` console for user/access management, listing/category moderation, rental oversight, purchase/subscription oversight, transactions/refunds, reports, audit history and analytics.
- Added additive Stage 4 migration for separate account suspension, category availability, MarketplaceReport, and AuditLog. Applied locally through `npm run db:stage4`; existing records were preserved.
- Reports are visible to their reporter and administrators; administrators update status and response, notify reporters, and create audit records.
- User suspension no longer changes external access approval. Admin API prevents self-suspension and suspension of the last active administrator.
- Analytics use database counts/grouping and SQLite date buckets; active user means approved and non-suspended, while actual login activity is not tracked. Simulated totals are not revenue.
- `npm run test:stage2`: 20 passed. `npm run test:stage4`: 42 passed, including Looking For end-to-end rental, purchase and subscription flows. `npm run test:auth-domain`: 2 passed.
- `npx prisma validate`: passed. `npm run build`: passed.
- Production-mode local API smoke: startup succeeded with temporary HTTPS origin/callback settings; `/api/auth/me` returned 200 and unauthenticated admin API returned 401. No database writes were made and no deployment occurred.
- Responsive behavior has CSS breakpoints but no browser visual checks were executed. Full browser E2E, performance benchmark and deployment were not completed.

## Looking For additions

- Additive migrations `20261110_stage5_looking_for` and `20261110_stage6_need_workflows` were applied locally without resetting existing data.
- Discovery and request detail routes are `/looking-for` and `/looking-for/:id`; the dashboard is `/dashboard/looking-for`. The main navigation includes Explore All, Rent, Lend, Sell, Looking For and Subscriptions.
- `npm run test:stage4` passes 42 tests; `npm run test:stage2` passes 20; `npm run test:auth-domain` passes 2; Prisma validation and the production build pass.
- Expiry notifications are checked lazily during Looking For reads and offer actions; no background scheduler is configured. Browser visual testing has not been performed.
