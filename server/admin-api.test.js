import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV = 'test';
const [{ app }, { prisma }] = await Promise.all([import('./index.js'), import('./db.js')]);
let server, baseUrl, users, listing, category, reportId;
const purchaseIds = [], transactionIds = [], listingIds = [], bookingIds = [];
const password = 'Rentol-stage4-test-password';
class Client {
  constructor() { this.cookies = new Map(); }
  async request(path, { method = 'GET', body } = {}) {
    const headers = {}; if (this.cookies.size) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) { const [pair, ...attrs] = cookie.split(';'); const i = pair.indexOf('='); const name = pair.slice(0, i); if (attrs.some((x) => x.trim().toLowerCase() === 'max-age=0')) this.cookies.delete(name); else this.cookies.set(name, pair.slice(i + 1)); }
    let data = null; try { data = await response.json(); } catch {} return { status: response.status, data };
  }
  async login(user) { return this.request('/auth/login', { method: 'POST', body: { email: user.email, password } }); }
}
let clients;

before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); baseUrl = `http://127.0.0.1:${server.address().port}`;
  const suffix = crypto.randomBytes(6).toString('hex'), passwordHash = await bcrypt.hash(password, 4);
  const rows = await Promise.all(['admin', 'admin2', 'student', 'external'].map((name) => prisma.user.create({ data: { fullName: `Stage 4 ${name}`, email: `stage4-${name}-${suffix}@iiita.ac.in`, passwordHash, role: name.startsWith('admin') ? 'ADMIN' : 'STUDENT', isApproved: name !== 'external', ...(name === 'external' ? { accessRequest: { create: { reason: 'Test request' } } } : {}) } })));
  users = Object.fromEntries(['admin', 'admin2', 'student', 'external'].map((name, index) => [name, rows[index]])); clients = Object.fromEntries(Object.keys(users).map((name) => [name, new Client()]));
  await Promise.all(['admin', 'admin2', 'student'].map(async (name) => assert.equal((await clients[name].login(users[name])).status, 200)));
  category = await prisma.category.findFirst({ where: { active: true, slug: { not: 'subscriptions' } } });
  listing = await prisma.listing.create({ data: { ownerId: users.admin2.id, categoryId: category.id, type: 'RENT', title: `Stage4 report listing ${suffix}`, description: 'Temporary test marketplace listing for the admin API.', quantity: 2, condition: 'GOOD', dailyPrice: 50, pickupLocation: 'Library' } });
  listingIds.push(listing.id);
});

after(async () => {
  try {
    await prisma.marketplaceReport.deleteMany({ where: { OR: [{ reporterId: { in: Object.values(users || {}).map((u) => u.id) } }, { reportedUserId: { in: Object.values(users || {}).map((u) => u.id) } }] } });
    await prisma.auditLog.deleteMany({ where: { administratorId: { in: Object.values(users || {}).map((u) => u.id) } } });
    await prisma.notification.deleteMany({ where: { recipientId: { in: Object.values(users || {}).map((u) => u.id) } } });
    await prisma.refund.deleteMany({ where: { transactionId: { in: transactionIds } } });
    await prisma.transaction.deleteMany({ where: { id: { in: transactionIds } } });
    await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    await prisma.purchaseRequest.deleteMany({ where: { id: { in: purchaseIds } } });
    if (listingIds.length) await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users || {}).map((u) => u.id) } } });
  } finally { await new Promise((resolve) => server?.close(resolve)); await prisma.$disconnect(); }
});

test('buyer and seller dashboard routes return only current-user records', async () => {
  const booking = await prisma.booking.create({ data: { listingId: listing.id, renterId: users.student.id, ownerId: users.admin2.id, startDate: new Date('2026-12-01T00:00:00.000Z'), endDate: new Date('2026-12-04T00:00:00.000Z'), quantity: 1, priceUnit: 'DAILY', rentalUnits: 3, originalAmount: 150, agreedAmount: 150, status: 'ACTIVE' } });
  bookingIds.push(booking.id);
  const unauthenticated = new Client();
  assert.equal((await unauthenticated.request('/dashboard/buyer')).status, 401);
  const buyer = await clients.student.request('/dashboard/buyer?limit=10');
  assert.equal(buyer.status, 200);
  assert.ok(buyer.data.rentals.some((row) => row.id === booking.id));
  assert.equal(buyer.data.counts.rentals, 1);
  const sameAccountSellerView = await clients.student.request('/dashboard/seller?limit=10');
  assert.equal(sameAccountSellerView.status, 200);
  assert.equal(sameAccountSellerView.data.rentals.some((row) => row.id === booking.id), false);
  const seller = await clients.admin2.request('/dashboard/seller?limit=10');
  assert.equal(seller.status, 200);
  assert.ok(seller.data.rentals.some((row) => row.id === booking.id));
  const unrelated = await clients.admin.request('/dashboard/seller?limit=10');
  assert.equal(unrelated.status, 200);
  assert.equal(unrelated.data.rentals.some((row) => row.id === booking.id), false);
  const summary = await clients.student.request('/dashboard/summary');
  assert.equal(summary.status, 200);
  assert.equal(summary.data.counts.activeRentals, 1);
});

test('Stage 4 reports, audit trail, account suspension, moderation, authorization and analytics', async (t) => {
  const unauth = new Client();
  await t.test('administrator endpoints reject unauthenticated and ordinary users', async () => {
    assert.equal((await unauth.request('/admin/users')).status, 401);
    assert.equal((await clients.student.request('/admin/users')).status, 403);
    assert.equal((await clients.student.request('/admin/analytics')).status, 403);
  });
  await t.test('users submit private reports and administrators resolve and audit them', async () => {
    assert.equal((await clients.student.request('/reports', { method: 'POST', body: { listingId: listing.id, reason: 'Inappropriate listing', description: 'This item needs a review from campus staff.' } })).status, 201);
    const report = (await clients.student.request('/reports/mine')).data[0]; reportId = report.id;
    assert.equal((await clients.admin2.request('/reports/mine')).data.length, 0);
    assert.equal((await clients.admin.request('/admin/reports')).data.some((row) => row.id === report.id), true);
    const updated = await clients.admin.request(`/admin/reports/${report.id}`, { method: 'PATCH', body: { status: 'RESOLVED', adminResponse: 'Reviewed with the listing owner.' } });
    assert.equal(updated.status, 200); assert.equal(updated.data.reviewedById, users.admin.id);
    assert.equal((await clients.student.request('/notifications')).data.some((note) => note.title === 'Report updated'), true);
    assert.equal((await clients.admin.request('/admin/audit')).data.some((row) => row.entityId === report.id && row.actionType === 'REPORT_UPDATED'), true);
    assert.equal((await clients.student.request('/admin/reports')).status, 403);
    assert.equal((await clients.student.request('/reports', { method: 'POST', body: { reportedUserId: users.student.id, reason: 'Suspicious user', description: 'Cannot report my own account.' } })).status, 400);
  });
  await t.test('suspension preserves approval state and blocks future authentication', async () => {
    assert.equal((await clients.admin.request(`/admin/users/${users.admin.id}/status`, { method: 'PATCH', body: { suspended: true } })).status, 400, 'administrator cannot suspend self');
    const result = await clients.admin.request(`/admin/users/${users.student.id}/status`, { method: 'PATCH', body: { suspended: true, reason: 'Policy review' } });
    assert.equal(result.status, 200); assert.equal(result.data.isApproved, true); assert.equal(result.data.suspended, true);
    assert.equal((await new Client().login(users.student)).status, 403);
    assert.equal((await clients.admin.request('/admin/users')).data.find((row) => row.id === users.student.id).suspended, true);
    assert.equal((await clients.admin.request(`/admin/users/${users.student.id}/status`, { method: 'PATCH', body: { suspended: false } })).status, 200);
    assert.equal((await new Client().login(users.student)).status, 200);
  });
  await t.test('listing moderation uses soft status changes and records audit history', async () => {
    assert.equal((await clients.admin.request(`/admin/listings/${listing.id}/moderation`, { method: 'PATCH', body: { status: 'REMOVED', reason: 'Reported' } })).status, 200);
    assert.equal((await prisma.listing.findUnique({ where: { id: listing.id } })).status, 'REMOVED');
    assert.equal((await clients.admin.request('/admin/audit?entityType=Listing')).data.some((row) => row.entityId === listing.id), true);
    assert.equal((await clients.student.request(`/listings/${listing.id}`)).status, 404);
  });
  await t.test('category controls are admin-only and preserve disabled category records', async () => {
    const categoryState = await clients.admin.request('/admin/categories');
    assert.equal(categoryState.status, 200); assert.ok(categoryState.data.some((row) => row.id === category.id));
    const renamed = await clients.admin.request(`/admin/categories/${category.id}`, { method: 'PATCH', body: { name: `${category.name} Stage4` } });
    assert.equal(renamed.status, 200); assert.equal(renamed.data.slug.includes('stage4'), true);
    assert.equal((await clients.admin.request(`/admin/categories/${category.id}`, { method: 'PATCH', body: { name: category.name } })).status, 200);
    assert.equal((await clients.admin.request(`/admin/categories/${category.id}`, { method: 'PATCH', body: { active: false } })).status, 200);
    assert.equal((await clients.student.request('/categories')).data.some((row) => row.id === category.id), false);
    assert.equal((await clients.admin.request(`/admin/categories/${category.id}`, { method: 'PATCH', body: { active: true } })).status, 200);
    assert.equal((await prisma.category.findUnique({ where: { id: category.id } })).name, category.name);
    const subscriptionCategories = await clients.admin.request('/admin/subscription-categories');
    const subscriptionCategory = subscriptionCategories.data.find((row) => row.active);
    if (subscriptionCategory) {
      assert.equal((await clients.admin.request(`/admin/subscription-categories/${subscriptionCategory.id}`, { method: 'PATCH', body: { active: false } })).status, 200);
      assert.equal((await clients.student.request('/subscriptions/categories')).data.some((row) => row.id === subscriptionCategory.id), false);
      assert.equal((await clients.admin.request(`/admin/subscription-categories/${subscriptionCategory.id}`, { method: 'PATCH', body: { active: true } })).status, 200);
    }
    assert.equal((await clients.admin.request('/admin/bookings')).status, 200);
    assert.equal((await clients.student.request('/admin/bookings')).status, 403);
    assert.equal((await clients.admin.request('/admin/marketplace')).status, 200);
    assert.equal((await clients.admin.request('/admin/transactions')).status, 200);
  });
  await t.test('administrator refund decisions persist and appear in audit history', async () => {
    const item = await prisma.listing.create({ data: { ownerId: users.student.id, categoryId: category.id, type: 'SELL', title: 'Stage 4 refund fixture', description: 'Temporary sale listing to test administrator refund review.', quantity: 1, condition: 'GOOD', salePrice: 100, pickupLocation: 'Library' } }); listingIds.push(item.id);
    const purchase = await prisma.purchaseRequest.create({ data: { listingId: item.id, buyerId: users.admin2.id, sellerId: users.student.id, originalAmount: 100, agreedAmount: 100, status: 'COMPLETED' } }); purchaseIds.push(purchase.id);
    const tx = await prisma.transaction.create({ data: { userId: users.admin2.id, purchaseRequestId: purchase.id, type: 'PURCHASE', amount: 100, status: 'SUCCESS' } }); transactionIds.push(tx.id);
    const requested = await clients.admin2.request(`/transactions/${tx.id}/refund`, { method: 'POST', body: { amount: 60, reason: 'Item arrived with damage.' } });
    assert.equal(requested.status, 201);
    const approved = await clients.admin.request(`/refunds/${requested.data.refund.id}`, { method: 'PATCH', body: { status: 'APPROVED' } });
    assert.equal(approved.status, 200); assert.equal(approved.data.refund.approvedById, users.admin.id);
    assert.equal((await clients.admin.request('/admin/audit?entityType=Refund')).data.some((row) => row.entityId === requested.data.refund.id && row.actionType === 'REFUND_APPROVED'), true);
    const processed = await clients.admin.request(`/refunds/${requested.data.refund.id}`, { method: 'PATCH', body: { status: 'PROCESSED' } });
    assert.equal(processed.status, 200); assert.equal(processed.data.refund.processedById, users.admin.id);
    assert.equal((await prisma.transaction.findUnique({ where: { id: tx.id } })).status, 'PARTIALLY_REFUNDED');
    assert.equal((await clients.admin.request('/admin/audit?entityType=Refund')).data.some((row) => row.entityId === requested.data.refund.id && row.actionType === 'REFUND_PROCESSED'), true);
    assert.equal((await clients.admin.request('/admin/transactions')).data.refunds.some((row) => row.id === requested.data.refund.id && row.status === 'PROCESSED'), true);
    assert.equal((await clients.admin2.request('/notifications')).data.some((row) => row.title === 'Simulated refund processed'), true);
    const secondTx = await prisma.transaction.create({ data: { userId: users.admin2.id, purchaseRequestId: purchase.id, type: 'PURCHASE', amount: 80, status: 'SUCCESS' } }); transactionIds.push(secondTx.id);
    const secondRequest = await clients.admin2.request(`/transactions/${secondTx.id}/refund`, { method: 'POST', body: { amount: 40, reason: 'The item had a missing part.' } });
    assert.equal(secondRequest.status, 201);
    const rejected = await clients.admin.request(`/refunds/${secondRequest.data.refund.id}`, { method: 'PATCH', body: { status: 'REJECTED', rejectionReason: 'The owner supplied proof of the item contents.' } });
    assert.equal(rejected.status, 200); assert.equal(rejected.data.refund.rejectedById, users.admin.id);
    assert.equal((await prisma.transaction.findUnique({ where: { id: secondTx.id } })).status, 'SUCCESS', 'rejection keeps the successful transaction intact');
    assert.equal((await clients.admin.request('/admin/transactions')).data.refunds.some((row) => row.id === secondRequest.data.refund.id && row.rejectionReason), true);
  });
  await t.test('analytics are database-backed, filtered and do not call simulated totals revenue', async () => {
    const result = await clients.admin.request('/admin/analytics?range=7d');
    assert.equal(result.status, 200); assert.ok(result.data.overview.totalUsers >= 4); assert.ok(result.data.overview.totalListings >= 1);
    assert.match(result.data.definition.activeUsers, /non-suspended/); assert.ok(Array.isArray(result.data.marketplace.listingActivity));
  });
});
