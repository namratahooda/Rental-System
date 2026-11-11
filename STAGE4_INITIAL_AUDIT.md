# Stage 4 Initial Audit

Inspection snapshot before Stage 4 implementation (2026-11-10).

## Architecture

- React 18, React Router and Vite frontend under `src/`; the application uses a single app shell and existing dashboard components.
- Express 5 API under `server/`, Prisma 6 ORM, and SQLite database.
- Cookie sessions are held in a process-local Map in `server/auth.js`. API middleware loads the current user from the database; admin routes check `role === ADMIN` on the backend.
- Existing marketplace and booking APIs are separated into `server/marketplace-routes.js` and `server/booking-routes.js`; the authentication and initial listing APIs are in `server/index.js`.
- Existing Stage 2/3 Prisma models cover listings, bookings, purchases, subscriptions, simulated transactions/refunds, reviews, notifications, conversations and messages.

## Existing administrator capabilities

The old dashboard exposed access request review, a basic user list, user status controls, summary counts, and listing removal. Backend APIs already checked administrator role. Refund review was available under Stage 3 APIs. There was no central view for rentals, purchases, memberships, transaction records, reports, or audit history.

## Analytics

The existing admin overview showed a few basic counts. There were no date filters, database-backed time series, category/type summaries, transaction status analytics, or stated definition for “active users.” The database has no user session activity events, so recent active-user analytics cannot be computed truthfully.

## Gaps and concerns identified

- Suspension reused `User.isApproved`, which could conflate an external user's campus approval with account suspension.
- No durable report/complaint model or reporting UI/API.
- No audit model or durable record of administrator changes.
- Admin views omitted existing rental, purchase, subscription and transaction data.
- Category records had no soft-deactivation state.
- Tests covered Stage 1–3 domain/API workflows but did not cover the missing admin panel, reports, audit, suspension, or analytics.
- Existing infrastructure is local SQLite with process-local sessions, image data in SQLite, and a Vite development proxy. No production host or deployment credentials are configured.
- No browser-based responsive inspection or formal security/performance testing was part of the repository suite.

## Stage 4 scope decisions

- Preserve one Rentol app and use the existing `/admin` route and visual styles.
- Add separate account suspension state; keep public registration and authorization rules unchanged.
- Use status changes for moderation and preserve relationships/history.
- Add concise report and audit models with limited, indexed fields; never write credentials into audit descriptions.
- Compute analytics with database counts/grouping/date buckets. Do not infer recent activity from account existence.
- Treat Lend and Rent as the current persisted `RENT` category/type because the existing schema has no distinct lending type.
- Prepare documentation and a production build but do not deploy without a configured host and verified production environment.
