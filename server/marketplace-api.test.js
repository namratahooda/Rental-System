import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV = 'test';
const [{ app }, { prisma }] = await Promise.all([import('./index.js'), import('./db.js')]);
let server, baseUrl, category, users, clients, subscriptionCategory;
const testListings = [], testPurchases = [], testMemberships = [], testConversations = [], testEmails = [];
const password = 'Rentol-stage3-test-password';
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

class Client {
  constructor() { this.cookies = new Map(); }
  async request(path, { method = 'GET', body, key } = {}) {
    const headers = {};
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetch(`${baseUrl}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';'); const splitAt = pair.indexOf('='); const name = pair.slice(0, splitAt); const value = pair.slice(splitAt + 1);
      if (attributes.some((attribute) => attribute.trim().toLowerCase() === 'max-age=0')) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    const raw = await response.text(); let data = null; try { data = raw ? JSON.parse(raw) : null; } catch { /* response is not JSON */ }
    return { status: response.status, data };
  }
  async login(user) { const result = await this.request('/auth/login', { method: 'POST', body: { email: user.email, password } }); assert.equal(result.status, 200); }
}

async function createSell(title, quantity = 1) {
  const listing = await prisma.listing.create({ data: { ownerId: users.owner.id, categoryId: category.id, type: 'SELL', title, description: 'A used item for a Stage 3 marketplace integration check.', quantity, condition: 'GOOD', salePrice: 1000, pickupLocation: 'Library' } });
  testListings.push(listing.id); return listing;
}
async function requestPurchase(client, listing, key = crypto.randomBytes(32).toString('base64url')) {
  return client.request(`/listings/${listing.id}/purchases`, { method: 'POST', key, body: { message: 'I would like to buy this.' } });
}
async function createTransaction(client, target, fields = {}) {
  const { idempotencyKey } = (await client.request('/transactions/key', { method: 'POST' })).data;
  return client.request('/transactions', { method: 'POST', key: idempotencyKey, body: { ...target, ...fields } });
}

before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); baseUrl = `http://127.0.0.1:${server.address().port}`;
  const suffix = crypto.randomBytes(7).toString('hex'); const passwordHash = await bcrypt.hash(password, 4);
  const created = await Promise.all(['owner', 'buyer', 'buyer2', 'outsider', 'admin'].map((name) => prisma.user.create({ data: { fullName: `Stage 3 ${name}`, email: `stage3-${name}-${suffix}@iiita.ac.in`, passwordHash, role: name === 'admin' ? 'ADMIN' : 'STUDENT', isApproved: true } })));
  users = Object.fromEntries(['owner', 'buyer', 'buyer2', 'outsider', 'admin'].map((name, index) => [name, created[index]])); testEmails.push(...created.map((user) => user.email));
  category = await prisma.category.findFirst({ where: { slug: { not: 'subscriptions' } } });
  subscriptionCategory = await prisma.subscriptionCategory.findUnique({ where: { slug: 'entertainment' } });
  clients = Object.fromEntries(Object.entries(users).map(([name]) => [name, new Client()]));
  await Promise.all(Object.keys(users).map((name) => clients[name].login(users[name])));
});

after(async () => {
  try {
    await prisma.notification.deleteMany({ where: { recipientId: { in: Object.values(users || {}).map((u) => u.id) } } });
    await prisma.message.deleteMany({ where: { conversationId: { in: testConversations } } });
    await prisma.conversation.deleteMany({ where: { id: { in: testConversations } } });
    await prisma.review.deleteMany({ where: { OR: [{ reviewerId: { in: Object.values(users || {}).map((u) => u.id) } }, { reviewedUserId: { in: Object.values(users || {}).map((u) => u.id) } }] } });
    await prisma.refund.deleteMany({ where: { transaction: { userId: { in: Object.values(users || {}).map((u) => u.id) } } } });
    await prisma.transaction.deleteMany({ where: { userId: { in: Object.values(users || {}).map((u) => u.id) } } });
    await prisma.purchaseOffer.deleteMany({ where: { requestId: { in: testPurchases } } });
    await prisma.purchaseRequest.deleteMany({ where: { id: { in: testPurchases } } });
    await prisma.subscriptionMembership.deleteMany({ where: { id: { in: testMemberships } } });
    await prisma.subscriptionListing.deleteMany({ where: { ownerId: { in: Object.values(users || {}).map((u) => u.id) } } });
    await prisma.listing.deleteMany({ where: { id: { in: testListings } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users || {}).map((u) => u.id) } } });
    await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  } finally { await new Promise((resolve) => server?.close(resolve)); await prisma.$disconnect(); }
});

test('Stage 3 purchase, subscription, transaction, refund, review, and messaging APIs enforce state and ownership', async (t) => {
  const listing = await createSell('Stage 3 single item');
  const unauth = new Client();

  await t.test('purchase request, proposal, seller permissions, and server-calculated checkout', async () => {
    const key = crypto.randomBytes(32).toString('base64url');
    assert.equal((await unauth.request(`/listings/${listing.id}/purchases`, { method: 'POST', key, body: {} })).status, 401);
    assert.equal((await requestPurchase(clients.owner, listing)).status, 400, 'seller cannot buy own item');
    const created = await requestPurchase(clients.buyer, listing, key);
    assert.equal(created.status, 201); testPurchases.push(created.data.request.id);
    assert.equal(created.data.request.originalAmount, 1000);
    assert.equal(created.data.request.agreedAmount, 1000);
    assert.equal((await requestPurchase(clients.buyer, listing, key)).data.duplicate, true);
    assert.equal((await clients.outsider.request(`/purchases/${created.data.request.id}`)).status, 404);
    assert.equal((await clients.outsider.request(`/purchases/${created.data.request.id}/accept`, { method: 'POST' })).status, 403);
    assert.equal((await clients.buyer.request(`/purchases/${created.data.request.id}/offers`, { method: 'POST', body: { proposedAmount: -1 } })).status, 400);
    assert.equal((await clients.owner.request(`/purchases/${created.data.request.id}/offers`, { method: 'POST', body: { proposedAmount: 800 } })).status, 403);
    const offer = await clients.buyer.request(`/purchases/${created.data.request.id}/offers`, { method: 'POST', body: { proposedAmount: 800, message: 'Would you consider this?' } });
    assert.equal(offer.status, 201);
    const acceptedOffer = await clients.owner.request(`/purchases/${created.data.request.id}/offers/${offer.data.offer.id}`, { method: 'PATCH', body: { response: 'ACCEPTED' } });
    assert.equal(acceptedOffer.data.request.agreedAmount, 800);
    assert.equal((await prisma.listing.findUnique({ where: { id: listing.id } })).salePrice, 1000, 'negotiation does not overwrite asking price');
    assert.equal((await clients.owner.request(`/purchases/${created.data.request.id}/accept`, { method: 'POST' })).status, 200);
    const payment = await createTransaction(clients.buyer, { purchaseRequestId: created.data.request.id }, { amount: 1, type: 'SUBSCRIPTION' });
    assert.equal(payment.status, 201);
    assert.equal(payment.data.transaction.amount, 800, 'amount comes from the accepted offer, not the request body');
    assert.equal((await clients.outsider.request(`/transactions/${payment.data.transaction.id}`)).status, 404);
    assert.equal((await clients.owner.request(`/transactions/${payment.data.transaction.id}`)).status, 200, 'the related seller can inspect the received payment record');
    assert.equal((await clients.owner.request(`/transactions/${payment.data.transaction.id}/resolve`, { method: 'POST', body: { outcome: 'SUCCESS' } })).status, 404, 'only the payer can resolve checkout');
    const successful = await clients.buyer.request(`/transactions/${payment.data.transaction.id}/resolve`, { method: 'POST', body: { outcome: 'SUCCESS' } });
    assert.equal(successful.status, 200); assert.equal(successful.data.transaction.status, 'SUCCESS');
    assert.equal((await clients.buyer.request(`/transactions/${payment.data.transaction.id}/resolve`, { method: 'POST', body: { outcome: 'SUCCESS' } })).status, 200, 'duplicate success confirmation is idempotent');
    assert.equal((await clients.buyer.request('/notifications')).data.filter((row) => row.transactionId === payment.data.transaction.id && row.title === 'Simulated payment successful').length, 1, 'a repeated confirmation does not duplicate its notification');
    const sold = await prisma.listing.findUnique({ where: { id: listing.id } });
    assert.equal(sold.status, 'SOLD'); assert.equal(sold.quantity, 0);
    assert.equal((await requestPurchase(clients.buyer2, listing)).status, 404, 'sold items cannot receive further requests');
    assert.equal((await clients.owner.request(`/listings/${listing.id}/status`, { method: 'PATCH', body: { status: 'ACTIVE' } })).status, 409, 'sold items cannot be relisted');
    assert.ok((await clients.buyer.request('/purchases')).data.some((row) => row.id === created.data.request.id && row.status === 'COMPLETED'));
    assert.ok((await clients.owner.request('/purchases?side=seller')).data.some((row) => row.id === created.data.request.id && row.status === 'COMPLETED'));
    assert.ok((await clients.buyer.request('/transactions')).data.some((row) => row.id === payment.data.transaction.id && row.purchaseRequestId === created.data.request.id));
    assert.ok((await clients.owner.request('/notifications')).data.some((row) => row.purchaseRequestId === created.data.request.id && row.title === 'Purchase completed'));
    assert.ok((await clients.buyer.request('/notifications')).data.some((row) => row.transactionId === payment.data.transaction.id && row.title === 'Simulated payment successful'));
    return { purchaseId: created.data.request.id, transactionId: payment.data.transaction.id };
  });

  await t.test('failed/cancelled simulated payments do not complete a sale', async () => {
    const item = await createSell('Stage 3 payment outcome item');
    const request = await requestPurchase(clients.buyer2, item); assert.equal(request.status, 201); testPurchases.push(request.data.request.id);
    assert.equal((await clients.owner.request(`/purchases/${request.data.request.id}/accept`, { method: 'POST' })).status, 200);
    const payment = await createTransaction(clients.buyer2, { purchaseRequestId: request.data.request.id });
    const failed = await clients.buyer2.request(`/transactions/${payment.data.transaction.id}/resolve`, { method: 'POST', body: { outcome: 'FAILED' } });
    assert.equal(failed.data.transaction.status, 'FAILED');
    assert.equal((await clients.owner.request(`/listings/${item.id}`)).data.status, 'ACTIVE');
    assert.equal((await clients.buyer2.request(`/purchases/${request.data.request.id}`)).data.status, 'PAYMENT_PENDING');
    assert.equal((await clients.buyer2.request(`/purchases/${request.data.request.id}/cancel`, { method: 'POST' })).data.request.status, 'CANCELLED');
  });

  await t.test('sold-out completion closes pending sibling requests and notifies the affected buyer', async () => {
    const item = await createSell('Stage 3 sold-out sibling item');
    const first = await requestPurchase(clients.buyer, item), sibling = await requestPurchase(clients.buyer2, item);
    testPurchases.push(first.data.request.id, sibling.data.request.id);
    assert.equal((await clients.owner.request(`/purchases/${first.data.request.id}/accept`, { method: 'POST' })).status, 200);
    const payment = await createTransaction(clients.buyer, { purchaseRequestId: first.data.request.id });
    assert.equal((await clients.buyer.request(`/transactions/${payment.data.transaction.id}/resolve`, { method: 'POST', body: { outcome: 'SUCCESS' } })).status, 200);
    assert.equal((await clients.buyer2.request(`/purchases/${sibling.data.request.id}`)).data.status, 'REJECTED');
    assert.ok((await clients.buyer2.request('/notifications')).data.some((note) => note.purchaseRequestId === sibling.data.request.id && note.title === 'Purchase request unavailable'));
    assert.equal(await prisma.transaction.count({ where: { purchaseRequestId: sibling.data.request.id, status: 'INITIATED' } }), 0);
  });

  await t.test('single-unit sale reservations prevent competing seller approvals', async () => {
    const item = await createSell('Stage 3 concurrency item');
    const a = await requestPurchase(clients.buyer, item), b = await requestPurchase(clients.buyer2, item);
    testPurchases.push(a.data.request.id, b.data.request.id);
    const results = await Promise.all([clients.owner.request(`/purchases/${a.data.request.id}/accept`, { method: 'POST' }), clients.owner.request(`/purchases/${b.data.request.id}/accept`, { method: 'POST' })]);
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 1);
    const rows = await prisma.purchaseRequest.findMany({ where: { id: { in: [a.data.request.id, b.data.request.id] } } });
    assert.equal(rows.filter((r) => r.status === 'ACCEPTED').length, 1);
  });

  await t.test('subscription listing validation, seat allocation, payment gate, and expiry release', async () => {
    const payload = { categoryId: subscriptionCategory.id, name: 'Stage 3 Shared Plan', description: 'Shared access for a test plan.', plan: 'Family', totalSeats: 2, durationDays: 30, startDate: day(0), expiryDate: day(30), pricePerSeat: 350, restrictions: 'Follow the provider sharing rules.', terms: 'No credentials are stored in Rentol.' };
    assert.equal((await unauth.request('/subscriptions', { method: 'POST', body: payload })).status, 401);
    assert.equal((await clients.owner.request('/subscriptions', { method: 'POST', body: { ...payload, totalSeats: 0 } })).status, 400);
    assert.equal((await clients.owner.request('/subscriptions', { method: 'POST', body: { ...payload, expiryDate: day(0) } })).status, 400);
    const created = await clients.owner.request('/subscriptions', { method: 'POST', body: payload });
    assert.equal(created.status, 201); const sub = created.data; 
    assert.equal(sub.availableSeats, 2);
    const memberReq = await clients.buyer.request(`/subscriptions/${sub.id}/requests`, { method: 'POST', body: { message: 'Please add me.' } });
    assert.equal(memberReq.status, 201); testMemberships.push(memberReq.data.membership.id);
    assert.equal((await clients.buyer.request(`/subscriptions/${sub.id}/requests`, { method: 'POST', body: {} })).status, 409, 'duplicate active seat requests reuse the one membership row');
    assert.equal(await prisma.subscriptionMembership.count({ where: { listingId: sub.id, userId: users.buyer.id } }), 1);
    assert.equal((await clients.outsider.request(`/subscriptions/memberships/${memberReq.data.membership.id}/approve`, { method: 'POST' })).status, 403);
    const approved = await clients.owner.request(`/subscriptions/memberships/${memberReq.data.membership.id}/approve`, { method: 'POST' });
    assert.equal(approved.status, 200); assert.equal(approved.data.membership.status, 'APPROVED'); assert.equal(approved.data.membership.listing.availableSeats, 1);
    assert.equal((await clients.owner.request(`/subscriptions/memberships/${memberReq.data.membership.id}/approve`, { method: 'POST' })).status, 409, 'a membership cannot reserve a second seat on repeat approval');
    assert.equal((await clients.buyer.request(`/subscriptions/memberships/${memberReq.data.membership.id}/resolve`, { method: 'POST' })).status, 404, 'membership cannot be activated through a membership status endpoint');
    const payment = await createTransaction(clients.buyer, { membershipId: memberReq.data.membership.id }, { amount: 1 });
    assert.equal(payment.data.transaction.amount, 350, 'subscription price is calculated from the stored seat amount');
    assert.equal((await clients.buyer.request('/subscriptions/memberships')).data.find((m) => m.id === memberReq.data.membership.id).status, 'PAYMENT_PENDING', 'approval reserves a seat but payment is required before activation');
    const failed = await clients.buyer.request(`/transactions/${payment.data.transaction.id}/resolve`, { method: 'POST', body: { outcome: 'FAILED' } });
    assert.equal(failed.data.transaction.membership.status, 'CANCELLED');
    assert.equal((await prisma.subscriptionListing.findUnique({ where: { id: sub.id } })).availableSeats, 2, 'failed payment releases its reserved seat');
    const retryRequest = await clients.buyer.request(`/subscriptions/${sub.id}/requests`, { method: 'POST', body: {} });
    assert.equal(retryRequest.status, 201);
    assert.equal((await clients.owner.request(`/subscriptions/memberships/${memberReq.data.membership.id}/approve`, { method: 'POST' })).status, 200);
    const retryPayment = await createTransaction(clients.buyer, { membershipId: memberReq.data.membership.id });
    const activated = await clients.buyer.request(`/transactions/${retryPayment.data.transaction.id}/resolve`, { method: 'POST', body: { outcome: 'SUCCESS' } });
    assert.equal(activated.data.transaction.membership.status, 'ACTIVE');
    assert.equal(activated.data.transaction.membership.listing.availableSeats, 1);
    assert.equal((await clients.buyer.request(`/transactions/${retryPayment.data.transaction.id}/resolve`, { method: 'POST', body: { outcome: 'SUCCESS' } })).status, 200, 'repeat membership payment confirmation is idempotent');
    assert.equal(await prisma.transaction.count({ where: { membershipId: memberReq.data.membership.id, status: 'SUCCESS' } }), 1);
    assert.equal((await clients.buyer.request(`/subscriptions/${sub.id}/requests`, { method: 'POST', body: {} })).status, 409, 'an active member cannot request a duplicate seat');
    assert.equal(await prisma.subscriptionMembership.count({ where: { listingId: sub.id, userId: users.buyer.id } }), 1);
    assert.equal((await clients.buyer.request('/transactions')).data.filter((row) => row.membershipId === memberReq.data.membership.id).length, 2, 'failed and successful attempts are both persisted as history');
    assert.equal((await clients.buyer.request('/reviews', { method: 'POST', body: { interactionType: 'SUBSCRIPTION', interactionId: memberReq.data.membership.id, rating: 5 } })).status, 403, 'an active subscription is not yet a completed review interaction');
    const third = await clients.outsider.request(`/subscriptions/${sub.id}/requests`, { method: 'POST', body: {} });
    assert.equal(third.status, 201); testMemberships.push(third.data.membership.id);
    assert.equal((await clients.owner.request(`/subscriptions/memberships/${third.data.membership.id}/approve`, { method: 'POST' })).status, 200);
    const noSeatRequest = await clients.buyer2.request(`/subscriptions/${sub.id}/requests`, { method: 'POST', body: {} });
    assert.equal(noSeatRequest.status, 409, 'new seat requests fail when no seats remain');
    const capacityListing = await clients.owner.request('/subscriptions', { method: 'POST', body: { ...payload, name: 'Stage 3 One Seat Plan', totalSeats: 1 } });
    assert.equal(capacityListing.status, 201);
    const [seatA, seatB] = await Promise.all([
      clients.buyer.request(`/subscriptions/${capacityListing.data.id}/requests`, { method: 'POST', body: {} }),
      clients.buyer2.request(`/subscriptions/${capacityListing.data.id}/requests`, { method: 'POST', body: {} }),
    ]);
    testMemberships.push(seatA.data.membership.id, seatB.data.membership.id);
    const approvals = await Promise.all([
      clients.owner.request(`/subscriptions/memberships/${seatA.data.membership.id}/approve`, { method: 'POST' }),
      clients.owner.request(`/subscriptions/memberships/${seatB.data.membership.id}/approve`, { method: 'POST' }),
    ]);
    assert.equal(approvals.filter((result) => result.status === 200).length, 1, 'only one concurrent approval can reserve the last seat');
    assert.equal(approvals.filter((result) => result.status === 409).length, 1);
    assert.equal((await prisma.subscriptionListing.findUnique({ where: { id: capacityListing.data.id } })).availableSeats, 0);
    const reservedMembership = approvals.find((result) => result.status === 200).data.membership;
    const memberClient = reservedMembership.userId === users.buyer.id ? clients.buyer : clients.buyer2;
    assert.equal((await memberClient.request(`/subscriptions/memberships/${reservedMembership.id}/cancel`, { method: 'POST' })).status, 200);
    assert.equal((await memberClient.request(`/subscriptions/memberships/${reservedMembership.id}/cancel`, { method: 'POST' })).status, 409);
    assert.equal((await prisma.subscriptionListing.findUnique({ where: { id: capacityListing.data.id } })).availableSeats, 1, 'a repeated cancel cannot release the same reserved seat twice');
    await prisma.subscriptionMembership.update({ where: { id: memberReq.data.membership.id }, data: { expiryDate: new Date(Date.now() - 86400000) } });
    const refreshed = await clients.buyer.request('/subscriptions/memberships');
    assert.equal(refreshed.data.find((m) => m.id === memberReq.data.membership.id).status, 'EXPIRED');
    assert.equal(refreshed.data.find((m) => m.id === memberReq.data.membership.id).listing.availableSeats, 1, 'expired membership releases its allocated seat');
    const subscriptionReview = await clients.buyer.request('/reviews', { method: 'POST', body: { interactionType: 'SUBSCRIPTION', interactionId: memberReq.data.membership.id, rating: 4, comment: 'Plan period completed.' } });
    assert.equal(subscriptionReview.status, 201);
    assert.equal((await clients.buyer.request('/reviews', { method: 'POST', body: { interactionType: 'SUBSCRIPTION', interactionId: memberReq.data.membership.id, rating: 3 } })).status, 409, 'one review is allowed per completed membership');
    assert.ok((await clients.buyer.request('/reviews/mine')).data.some((review) => review.id === subscriptionReview.data.review.id && review.subscriptionMembershipId === memberReq.data.membership.id));
    assert.ok((await clients.owner.request('/notifications')).data.some((note) => note.title === 'New marketplace review' && note.message.includes('4-star')));
  });

  await t.test('refunds are bounded and admin-controlled; reviews require completed interactions', async () => {
    const tx = await prisma.transaction.findFirst({ where: { userId: users.buyer.id, type: 'PURCHASE', status: 'SUCCESS' }, include: { purchaseRequest: true } });
    assert.ok(tx);
    assert.equal((await clients.buyer.request(`/transactions/${tx.id}/refund`, { method: 'POST', body: { amount: tx.amount + 1, reason: 'Too much' } })).status, 400);
    assert.equal((await clients.owner.request(`/transactions/${tx.id}/refund`, { method: 'POST', body: { amount: 100, reason: 'Not payer' } })).status, 404);
    const refund = await clients.buyer.request(`/transactions/${tx.id}/refund`, { method: 'POST', body: { amount: 100, reason: 'Demo partial refund check' } });
    assert.equal(refund.status, 201);
    assert.equal((await clients.outsider.request(`/admin/refunds/${refund.data.refund.id}`, { method: 'PATCH', body: { status: 'APPROVED' } })).status, 403);
    assert.equal((await clients.outsider.request(`/refunds/${refund.data.refund.id}`, { method: 'PATCH', body: { status: 'REJECTED', rejectionReason: 'Not authorized' } })).status, 403);
    assert.equal((await clients.buyer.request(`/refunds/${refund.data.refund.id}`, { method: 'PATCH', body: { status: 'APPROVED' } })).status, 403, 'the requester cannot approve their own refund');
    assert.equal((await clients.owner.request(`/refunds/${refund.data.refund.id}`, { method: 'PATCH', body: { status: 'APPROVED' } })).status, 200);
    const approved = (await prisma.refund.findUnique({ where: { id: refund.data.refund.id } }));
    assert.equal(approved.approvedById, users.owner.id); assert.ok(approved.approvedAt);
    assert.ok((await clients.buyer.request('/notifications')).data.some((note) => note.title === 'Simulated refund approved' && note.transactionId === tx.id));
    const incomingRefund = (await clients.owner.request('/transactions/received')).data.find((row) => row.id === tx.id).refunds[0];
    assert.equal(incomingRefund.requestedBy.fullName, users.buyer.fullName);
    assert.equal(incomingRefund.amount, 100);
    assert.ok((await clients.admin.request('/admin/refunds')).data.some((row) => row.id === refund.data.refund.id && row.transaction.amount === tx.amount));
    assert.equal((await clients.admin.request(`/refunds/${refund.data.refund.id}`, { method: 'PATCH', body: { status: 'APPROVED' } })).status, 409, 'duplicate approval is rejected safely');
    assert.equal((await clients.owner.request(`/refunds/${refund.data.refund.id}`, { method: 'PATCH', body: { status: 'PROCESSED' } })).status, 200);
    assert.equal((await clients.admin.request(`/refunds/${refund.data.refund.id}`, { method: 'PATCH', body: { status: 'PROCESSED' } })).status, 409, 'a processed refund cannot be processed again');
    const processedDetails = (await clients.buyer.request('/transactions')).data.find((row) => row.id === tx.id).refunds.find((row) => row.id === refund.data.refund.id);
    assert.equal(processedDetails.processedById, users.owner.id); assert.ok(processedDetails.processedAt);
    assert.ok((await clients.buyer.request('/notifications')).data.some((note) => note.title === 'Simulated refund processed' && note.transactionId === tx.id));
    assert.equal((await prisma.transaction.findUnique({ where: { id: tx.id } })).status, 'PARTIALLY_REFUNDED');
    assert.equal((await clients.buyer.request(`/transactions/${tx.id}/refund`, { method: 'POST', body: { amount: tx.amount - 99, reason: 'Exceeds remaining refundable amount' } })).status, 400);
    const finalRefund = await clients.buyer.request(`/transactions/${tx.id}/refund`, { method: 'POST', body: { amount: tx.amount - 100, reason: 'Refund remaining amount' } });
    assert.equal(finalRefund.status, 201);
    assert.equal((await clients.admin.request(`/admin/refunds/${finalRefund.data.refund.id}`, { method: 'PATCH', body: { status: 'APPROVED' } })).status, 200);
    assert.equal((await clients.admin.request(`/admin/refunds/${finalRefund.data.refund.id}`, { method: 'PATCH', body: { status: 'PROCESSED' } })).status, 200);
    assert.equal((await prisma.transaction.findUnique({ where: { id: tx.id } })).status, 'REFUNDED');
    assert.equal((await clients.buyer.request('/transactions')).data.find((row) => row.id === tx.id).refunds.filter((row) => row.status === 'PROCESSED').length, 2, 'both processed partial refunds appear in persisted transaction history');

    const rejectedItem = await createSell('Stage 3 rejected refund item');
    const rejectedPurchase = await requestPurchase(clients.buyer, rejectedItem); testPurchases.push(rejectedPurchase.data.request.id);
    await clients.owner.request(`/purchases/${rejectedPurchase.data.request.id}/accept`, { method: 'POST' });
    const rejectedPayment = await createTransaction(clients.buyer, { purchaseRequestId: rejectedPurchase.data.request.id });
    await clients.buyer.request(`/transactions/${rejectedPayment.data.transaction.id}/resolve`, { method: 'POST', body: { outcome: 'SUCCESS' } });
    const rejectedRequest = await clients.buyer.request(`/transactions/${rejectedPayment.data.transaction.id}/refund`, { method: 'POST', body: { amount: 200, reason: 'Item description was inaccurate.' } });
    const rejectedRefundId = rejectedRequest.data.refund.id;
    assert.equal((await clients.owner.request(`/refunds/${rejectedRefundId}`, { method: 'PATCH', body: { status: 'REJECTED' } })).status, 400, 'a rejection reason is required');
    assert.equal((await clients.outsider.request(`/refunds/${rejectedRefundId}`, { method: 'PATCH', body: { status: 'REJECTED', rejectionReason: 'Not authorized' } })).status, 403);
    const rejected = await clients.owner.request(`/refunds/${rejectedRefundId}`, { method: 'PATCH', body: { status: 'REJECTED', rejectionReason: 'Evidence does not support a refund.' } });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.refund.rejectedById, users.owner.id);
    assert.ok(rejected.data.refund.rejectedAt);
    assert.equal(rejected.data.refund.rejectionReason, 'Evidence does not support a refund.');
    assert.equal((await prisma.transaction.findUnique({ where: { id: rejectedPayment.data.transaction.id } })).status, 'SUCCESS', 'rejection preserves the successful payment');
    assert.equal((await clients.owner.request(`/refunds/${rejectedRefundId}`, { method: 'PATCH', body: { status: 'PROCESSED' } })).status, 409, 'a rejected refund cannot be processed');
    assert.ok((await clients.buyer.request('/notifications')).data.some((note) => note.title === 'Simulated refund rejected' && note.message.includes('Evidence does not support')));
    const refreshedHistory = (await clients.buyer.request('/transactions')).data.find((row) => row.id === rejectedPayment.data.transaction.id);
    assert.equal(refreshedHistory.refunds[0].rejectionReason, 'Evidence does not support a refund.', 'rejection details persist in refreshed transaction history');
    assert.equal((await clients.buyer.request('/reviews', { method: 'POST', body: { interactionType: 'PURCHASE', interactionId: tx.purchaseRequestId, rating: 0 } })).status, 400);
    const review = await clients.buyer.request('/reviews', { method: 'POST', body: { interactionType: 'PURCHASE', interactionId: tx.purchaseRequestId, rating: 5, comment: 'Smooth campus handoff.' } });
    assert.equal(review.status, 201);
    assert.equal((await clients.buyer.request('/reviews', { method: 'POST', body: { interactionType: 'PURCHASE', interactionId: tx.purchaseRequestId, rating: 4 } })).status, 409);
    const summary = await clients.owner.request(`/users/${users.owner.id}/reviews`);
    assert.equal(summary.data.count, 2); assert.equal(summary.data.average, 4.5);
    assert.equal((await clients.admin.request(`/admin/reviews/${review.data.review.id}`, { method: 'PATCH', body: { status: 'HIDDEN' } })).status, 200);
    assert.equal((await clients.owner.request(`/users/${users.owner.id}/reviews`)).data.count, 1, 'only the hidden review is removed from the public summary');
  });

  await t.test('conversation messages derive sender, remain private, and persist read state', async () => {
    const rental = await prisma.listing.create({ data: { ownerId: users.owner.id, categoryId: category.id, type: 'RENT', title: 'Stage 3 message fixture', description: 'Conversation listing for messages.', quantity: 1, condition: 'GOOD', dailyPrice: 100, pickupLocation: 'Library' } }); testListings.push(rental.id);
    const created = await clients.buyer.request('/conversations', { method: 'POST', body: { listingId: rental.id } });
    assert.equal(created.status, 201); const conversation = created.data.conversation; testConversations.push(conversation.id);
    const reopened = await clients.buyer.request('/conversations', { method: 'POST', body: { listingId: rental.id } });
    assert.equal(reopened.data.conversation.id, conversation.id, 'the same participants and context reuse one conversation');
    assert.equal(await prisma.conversation.count({ where: { key: conversation.key } }), 1);
    const sent = await clients.buyer.request(`/conversations/${conversation.id}/messages`, { method: 'POST', body: { text: 'Is pickup after class possible?', senderId: users.owner.id } });
    assert.equal(sent.status, 201); assert.equal(sent.data.message.senderId, users.buyer.id);
    assert.equal((await clients.outsider.request(`/conversations/${conversation.id}/messages`)).status, 404);
    assert.equal((await clients.outsider.request(`/conversations/${conversation.id}/messages`, { method: 'POST', body: { text: 'intrude' } })).status, 404);
    assert.equal((await clients.owner.request(`/conversations/${conversation.id}/read`, { method: 'PATCH' })).data.updated, 1);
    assert.equal((await clients.owner.request('/conversations')).data.find((row) => row.id === conversation.id).unreadCount, 0);
    const messages = await clients.owner.request(`/conversations/${conversation.id}/messages`);
    assert.ok(messages.data[0].readAt);
    const messageNotification = (await clients.owner.request('/notifications')).data.find((note) => note.conversationId === conversation.id && note.title === 'New message');
    assert.ok(messageNotification);
    assert.equal((await clients.outsider.request(`/notifications/${messageNotification.id}/read`, { method: 'PATCH' })).status, 404);
    assert.equal((await clients.owner.request(`/notifications/${messageNotification.id}/read`, { method: 'PATCH' })).status, 200);
    assert.equal((await clients.owner.request('/notifications')).data.find((note) => note.id === messageNotification.id).isRead, true);
  });
});
