# Stage 4 Defect and Limitation Log

| ID | Description | Severity | Root cause / module | Fix or follow-up | Retest |
|---|---|---|---|---|---|
| D4-01 | Suspension changed the same `isApproved` value used for external access approval. | High | `User` model and old admin status handler | Added independent `suspended` state; auth rejects suspended users; suspension/reactivation now preserve approval. | Stage 4 API test passed. |
| D4-02 | Admin review, complaint and broad marketplace oversight were absent. | High | Admin UI/API scope only covered basic access and listings. | Added central console, reports, oversight endpoints and action audit rows. | Stage 4 API checks passed; some read-only pages are not individually asserted. |
| D4-03 | Analytics date buckets failed JSON serialization because SQLite returned `BigInt`. | Medium | `/admin/analytics` SQLite raw aggregate response. | Convert raw bucket totals to JSON-safe numbers before returning. | Analytics integration test passed; production build passed. |
| D4-04 | Existing booking test cleanup did not know about the new access-review audit foreign key. | Medium (test infrastructure) | `server/booking-api.test.js` teardown. | Delete test audit/report rows before fixture users; extended marketplace teardown similarly. | Full Stage 3 runner passed. |

## Remaining known limitations

- Sessions remain process-local and SQLite is not suitable for concurrent multi-instance production traffic. This predates Stage 4 and is documented in README.
- The report workflow sends in-app notifications only; it does not send email/SMS.
- There is no distinct `LEND` enum value, so analytics reports persisted `RENT` listings as combined rent/lend.
- Browser-driven end-to-end, visual responsive, full performance benchmark, penetration, and production deployment checks remain unperformed. No host configuration or credentials were present.
- `AuditLog` is application-level history and does not protect against direct database edits by an operator.
