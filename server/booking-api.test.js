import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV = 'test';
const [{ app }, { prisma }] = await Promise.all([import('./index.js'), import('./db.js')]);
let server;
let baseUrl;
let category;
let owner;
let renter;
let secondRenter;
let outsider;
let admin;
let testListings = [];
let testBookings = [];
let testUsers = [];
let testEmails = [];
let ownerClient;
let renterClient;
let secondRenterClient;
let outsiderClient;
let adminClient;
let today;

function addDays(day, count) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * 86400000).toISOString().slice(0, 10);
}

class Client {
  constructor() { this.cookies = new Map(); }
  async request(path, { method = 'GET', body, key } = {}) {
    const headers = {};
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetch(`${baseUrl}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';');
      const splitAt = pair.indexOf('=');
      const name = pair.slice(0, splitAt);
      const value = pair.slice(splitAt + 1);
      if (attributes.some((attribute) => attribute.trim().toLowerCase() === 'max-age=0')) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* keep non-JSON error response as null */ }
    return { status: response.status, data };
  }
  async login(user) {
    const result = await this.request('/auth/login', { method: 'POST', body: { email: user.email, password: 'Rental-test-password-932' } });
    assert.equal(result.status, 200, 'fixture account should log in');
    return result;
  }
}

async function createListing(quantity = 3, deposit = null) {
  const listing = await prisma.listing.create({
    data: { ownerId: owner.id, categoryId: category.id, type: 'RENT', title: `Booking API fixture ${testListings.length + 1}`, description: 'Temporary test listing for rental booking checks.', quantity, condition: 'GOOD', dailyPrice: 100, monthlyPrice: 2000, deposit, pickupLocation: 'Library' },
  });
  testListings.push(listing.id);
  return listing;
}

async function createRequest(client, listing, overrides = {}, key = crypto.randomUUID()) {
  return client.request(`/listings/${listing.id}/bookings`, {
    method: 'POST',
    key,
    body: { startDate: addDays(today, 2), endDate: addDays(today, 5), quantity: 1, priceUnit: 'DAILY', ...overrides },
  });
}

before(async () => {
  today = new Date().toISOString().slice(0, 10);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 14);
  const passwordHash = await bcrypt.hash('Rental-test-password-932', 4);
  const users = await Promise.all(['owner', 'renter', 'renter2', 'outsider', 'admin'].map((label) => prisma.user.create({
    data: { fullName: `Rental ${label}`, email: `rental-${label}-${suffix}@iiita.ac.in`, passwordHash, role: label === 'admin' ? 'ADMIN' : 'STUDENT', isApproved: true },
  })));
  [owner, renter, secondRenter, outsider, admin] = users;
  testUsers = users.map((user) => user.id);
  testEmails = users.map((user) => user.email);
  category = await prisma.category.create({ data: { name: `Rental API ${suffix}`, slug: `rental-api-${suffix}` } });
  ownerClient = new Client(); renterClient = new Client(); secondRenterClient = new Client(); outsiderClient = new Client(); adminClient = new Client();
  await Promise.all([ownerClient.login(owner), renterClient.login(renter), secondRenterClient.login(secondRenter), outsiderClient.login(outsider), adminClient.login(admin)]);
});

after(async () => {
  try {
    const bookings = await prisma.booking.findMany({ where: { listingId: { in: testListings } }, select: { id: true } });
    const bookingIds = bookings.map((booking) => booking.id);
    await prisma.notification.deleteMany({ where: { OR: [{ recipientId: { in: testUsers } }, { bookingId: { in: bookingIds } }] } });
    await prisma.depositRecord.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    await prisma.listing.deleteMany({ where: { id: { in: testListings } } });
    if (category) await prisma.category.delete({ where: { id: category.id } });
    await prisma.user.deleteMany({ where: { id: { in: testUsers } } });
    await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  } finally {
    await new Promise((resolve) => server?.close(resolve));
    await prisma.$disconnect();
  }
});

test('rental booking API enforces availability, authorization, negotiation, lifecycle, notifications and idempotency', async (t) => {
  const listing = await createListing(3);
  const own = await prisma.listing.create({ data: { ownerId: renter.id, categoryId: category.id, type: 'RENT', title: 'Renter own item', description: 'Temporary fixture listing owned by requester.', quantity: 1, condition: 'GOOD', dailyPrice: 100, pickupLocation: 'Library' } });
  testListings.push(own.id);
  const monthlyOnly = await prisma.listing.create({ data: { ownerId: owner.id, categoryId: category.id, type: 'RENT', title: 'Monthly-only fixture', description: 'Temporary monthly-only rental listing.', quantity: 1, condition: 'GOOD', monthlyPrice: 2000, pickupLocation: 'Library' } });
  testListings.push(monthlyOnly.id);

  await t.test('authentication and request validation', async () => {
    const anonymous = new Client();
    assert.equal((await anonymous.request('/booking-key', { method: 'POST' })).status, 401, 'anonymous users cannot request booking keys');
    const bookingKey = await renterClient.request('/booking-key', { method: 'POST' });
    assert.equal(bookingKey.status, 200);
    assert.match(bookingKey.data.idempotencyKey, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await anonymous.request(`/listings/${listing.id}/bookings`, { method: 'POST', key: crypto.randomUUID(), body: {} })).status, 401);
    assert.equal((await createRequest(renterClient, own)).status, 400, 'renter cannot book their own listing');
    assert.equal((await createRequest(renterClient, listing, { startDate: addDays(today, -1) })).status, 400, 'past dates are rejected');
    assert.equal((await createRequest(renterClient, listing, { startDate: addDays(today, 4), endDate: addDays(today, 3) })).status, 400, 'reversed dates are rejected');
    assert.equal((await createRequest(renterClient, listing, { quantity: 0 })).status, 400, 'zero quantity is rejected');
    assert.equal((await createRequest(renterClient, listing, { quantity: -1 })).status, 400, 'negative quantity is rejected');
    assert.equal((await createRequest(renterClient, listing, { quantity: 4 })).status, 400, 'quantity exceeding inventory is rejected');
    assert.equal((await createRequest(renterClient, listing, { discountPercentage: 25 })).status, 400, 'unsupported discount is rejected');
    assert.equal((await createRequest(renterClient, monthlyOnly, { priceUnit: 'DAILY' })).status, 400, 'unavailable listing price unit is rejected');
  });

  let initialBooking;
  let idempotencyKey = crypto.randomUUID();
  await t.test('booking creates a pending record, owner notification, proposal and duplicate-safe response', async () => {
    const response = await createRequest(renterClient, listing, { quantity: 2, dailyPrice: 1, originalAmount: 1, agreedAmount: 1, rentalUnits: 1, discountPercentage: 10, negotiationMessage: 'Could you consider this price?', message: 'I can collect from the library.' }, idempotencyKey);
    assert.equal(response.status, 201);
    initialBooking = response.data.booking;
    testBookings.push(initialBooking.id);
    assert.equal(initialBooking.status, 'PENDING');
    assert.equal(initialBooking.quantity, 2);
    assert.equal(initialBooking.priceUnit, 'DAILY');
    assert.equal(initialBooking.rentalUnits, 3);
    assert.equal(initialBooking.originalAmount, 600);
    assert.equal(initialBooking.agreedAmount, 600);
    assert.equal(initialBooking.negotiation.proposedAmount, 540);
    const duplicate = await createRequest(renterClient, listing, { quantity: 2, discountPercentage: 10 }, idempotencyKey);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data.duplicate, true);
    assert.equal(duplicate.data.booking.id, initialBooking.id);
    const ownerNotifications = await ownerClient.request('/notifications');
    assert.equal(ownerNotifications.status, 200);
    assert.ok(ownerNotifications.data.some((row) => row.bookingId === initialBooking.id && row.title === 'New rental request'));
    const availability = await renterClient.request(`/listings/${listing.id}/availability?from=${initialBooking.startDate.slice(0, 10)}&to=${initialBooking.endDate.slice(0, 10)}`);
    assert.equal(availability.status, 200);
    assert.ok(availability.data.days.every((day) => day.remaining === 3 && day.pending === 1), 'pending requests are marked without reserving inventory');
  });

  await t.test('booking details and owner actions enforce participant authorization', async () => {
    assert.equal((await outsiderClient.request(`/bookings/${initialBooking.id}`)).status, 404);
    assert.equal((await renterClient.request(`/bookings/${initialBooking.id}/approve`, { method: 'POST' })).status, 403);
    assert.equal((await outsiderClient.request(`/bookings/${initialBooking.id}/reject`, { method: 'POST' })).status, 403);
    const acceptedByRenter = await renterClient.request(`/bookings/${initialBooking.id}/negotiation`, { method: 'PATCH', body: { response: 'ACCEPTED' } });
    assert.equal(acceptedByRenter.status, 403);
    const acceptedByAdmin = await adminClient.request(`/bookings/${initialBooking.id}/negotiation`, { method: 'PATCH', body: { response: 'ACCEPTED' } });
    assert.equal(acceptedByAdmin.status, 403, 'only the listing owner may respond to a proposal');
  });

  await t.test('owner can accept the proposal and approve only after availability is rechecked', async () => {
    const accepted = await ownerClient.request(`/bookings/${initialBooking.id}/negotiation`, { method: 'PATCH', body: { response: 'ACCEPTED' } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.booking.agreedAmount, 540);
    assert.ok((await renterClient.request('/notifications')).data.some((row) => row.bookingId === initialBooking.id && row.title.includes('accepted')));
    const approved = await ownerClient.request(`/bookings/${initialBooking.id}/approve`, { method: 'POST' });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.booking.status, 'APPROVED');
    assert.equal((await ownerClient.request(`/listings/${listing.id}`, { method: 'PATCH', body: { quantity: 1 } })).status, 409, 'owner cannot lower stock below approved reservations');
    const bookedAvailability = await ownerClient.request(`/listings/${listing.id}/availability?from=${initialBooking.startDate.slice(0, 10)}&to=${initialBooking.endDate.slice(0, 10)}`);
    assert.ok(bookedAvailability.data.days.every((day) => day.remaining === 1 && day.pending === 0));
    const blocked = await createRequest(secondRenterClient, listing, { quantity: 2 });
    assert.equal(blocked.status, 409, 'approved quantity reduces availability');
    const renterNotifications = await renterClient.request('/notifications');
    assert.ok(renterNotifications.data.some((row) => row.bookingId === initialBooking.id && row.title === 'Rental request approved'));
  });

  await t.test('owner can reject or decline a proposal without changing the listed amount', async () => {
    const rejected = await createRequest(renterClient, listing, { startDate: addDays(today, 20), endDate: addDays(today, 22), discountPercentage: 15 });
    assert.equal(rejected.status, 201); testBookings.push(rejected.data.booking.id);
    const proposalRejected = await ownerClient.request(`/bookings/${rejected.data.booking.id}/negotiation`, { method: 'PATCH', body: { response: 'REJECTED' } });
    assert.equal(proposalRejected.status, 200);
    assert.equal(proposalRejected.data.booking.agreedAmount, proposalRejected.data.booking.originalAmount);
    assert.equal((await renterClient.request(`/bookings/${rejected.data.booking.id}/negotiations`, { method: 'POST', body: { discountPercentage: 20 } })).status, 409);

    const declined = await createRequest(secondRenterClient, listing, { startDate: addDays(today, 24), endDate: addDays(today, 26), discountPercentage: 20 });
    assert.equal(declined.status, 201); testBookings.push(declined.data.booking.id);
    const proposalDeclined = await ownerClient.request(`/bookings/${declined.data.booking.id}/negotiation`, { method: 'PATCH', body: { response: 'DECLINED' } });
    assert.equal(proposalDeclined.status, 200);
    assert.equal(proposalDeclined.data.booking.agreedAmount, proposalDeclined.data.booking.originalAmount);
  });

  await t.test('owner rejection notifies the renter and releases the requested dates', async () => {
    const request = await createRequest(secondRenterClient, listing, { startDate: addDays(today, 28), endDate: addDays(today, 30), quantity: 3, discountPercentage: 10 });
    assert.equal(request.status, 201); testBookings.push(request.data.booking.id);
    const rejected = await ownerClient.request(`/bookings/${request.data.booking.id}/reject`, { method: 'POST' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.booking.status, 'REJECTED');
    assert.equal(rejected.data.booking.negotiation.status, 'REJECTED');
    assert.equal((await ownerClient.request(`/bookings/${request.data.booking.id}/approve`, { method: 'POST' })).status, 409, 'rejected bookings cannot be approved');
    assert.equal((await ownerClient.request(`/bookings/${request.data.booking.id}/activate`, { method: 'POST' })).status, 409, 'rejected bookings cannot be activated');
    const notes = await secondRenterClient.request('/notifications');
    assert.ok(notes.data.some((row) => row.bookingId === request.data.booking.id && row.title === 'Rental request declined'));
    const replacement = await createRequest(renterClient, listing, { startDate: addDays(today, 28), endDate: addDays(today, 30), quantity: 3 });
    assert.equal(replacement.status, 201, 'rejection releases the requested inventory');
    testBookings.push(replacement.data.booking.id);
  });

  await t.test('non-overlapping bookings remain available and a renter can cancel their pending request', async () => {
    const dates = { startDate: addDays(today, 8), endDate: addDays(today, 10), quantity: 3, discountPercentage: 10 };
    const request = await createRequest(secondRenterClient, listing, dates);
    assert.equal(request.status, 201);
    testBookings.push(request.data.booking.id);
    assert.equal((await ownerClient.request(`/bookings/${request.data.booking.id}/cancel`, { method: 'POST' })).status, 403);
    const cancelled = await secondRenterClient.request(`/bookings/${request.data.booking.id}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.booking.status, 'CANCELLED');
    assert.equal(cancelled.data.booking.negotiation.status, 'CANCELLED');
    assert.ok((await ownerClient.request('/notifications')).data.some((row) => row.bookingId === cancelled.data.booking.id && row.title === 'Rental request cancelled'));
  });

  await t.test('approved requests can be cancelled only by the renter before their start date', async () => {
    const future = await createRequest(secondRenterClient, listing, { startDate: addDays(today, 6), endDate: addDays(today, 7), quantity: 1 });
    assert.equal(future.status, 201);
    testBookings.push(future.data.booking.id);
    assert.equal((await ownerClient.request(`/bookings/${future.data.booking.id}/approve`, { method: 'POST' })).status, 200);
    assert.equal((await ownerClient.request(`/bookings/${future.data.booking.id}/activate`, { method: 'POST' })).status, 409);
    const cancelled = await secondRenterClient.request(`/bookings/${future.data.booking.id}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.booking.status, 'CANCELLED');
    const released = await ownerClient.request(`/listings/${listing.id}/availability?from=${future.data.booking.startDate.slice(0, 10)}&to=${future.data.booking.endDate.slice(0, 10)}`);
    assert.ok(released.data.days.every((day) => day.remaining === 3), 'cancellation releases the approved quantity');
  });

  await t.test('owner starts and completes rentals with recorded return timestamp', async () => {
    const oneUnit = await createListing(1, 400);
    const sameDay = await createRequest(renterClient, oneUnit, { startDate: today, endDate: addDays(today, 1), quantity: 1 });
    assert.equal(sameDay.status, 201);
    testBookings.push(sameDay.data.booking.id);
    const approved = await ownerClient.request(`/bookings/${sameDay.data.booking.id}/approve`, { method: 'POST' });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.booking.depositRecord.amount, 400, 'deposit is recorded separately from the rental price');
    const active = await ownerClient.request(`/bookings/${sameDay.data.booking.id}/activate`, { method: 'POST' });
    assert.equal(active.status, 200);
    assert.equal(active.data.booking.status, 'ACTIVE');
    assert.equal((await outsiderClient.request(`/bookings/${sameDay.data.booking.id}/complete`, { method: 'POST' })).status, 403);
    const completed = await ownerClient.request(`/bookings/${sameDay.data.booking.id}/complete`, { method: 'POST', body: { deductionAmount: 100, deductionReason: 'Minor cleaning' } });
    assert.equal(completed.status, 200);
    assert.equal(completed.data.booking.status, 'COMPLETED');
    assert.ok(completed.data.booking.completedAt);
    assert.equal(completed.data.booking.depositRecord.status, 'DEDUCTED');
    assert.equal(completed.data.booking.depositRecord.deductionAmount, 100);
    assert.equal((await renterClient.request(`/bookings/${sameDay.data.booking.id}`)).data.status, 'COMPLETED');
    assert.ok((await renterClient.request('/bookings')).data.some((booking) => booking.id === sameDay.data.booking.id && booking.status === 'COMPLETED'), 'completed bookings remain in rental history');
    const afterReturn = await ownerClient.request(`/listings/${oneUnit.id}/availability?from=${today}&to=${addDays(today, 1)}`);
    assert.equal(afterReturn.data.days[0].remaining, 1, 'completed rentals no longer reserve inventory');
    assert.equal((await ownerClient.request(`/bookings/${sameDay.data.booking.id}/complete`, { method: 'POST' })).status, 409, 'completed bookings cannot transition again');
  });

  await t.test('simultaneous approvals cannot overbook the same one-unit dates', async () => {
    const oneUnit = await createListing(1);
    const dates = { startDate: addDays(today, 12), endDate: addDays(today, 14) };
    const first = await createRequest(renterClient, oneUnit, dates);
    const second = await createRequest(secondRenterClient, oneUnit, dates);
    assert.equal(first.status, 201); assert.equal(second.status, 201);
    testBookings.push(first.data.booking.id, second.data.booking.id);
    const results = await Promise.all([
      ownerClient.request(`/bookings/${first.data.booking.id}/approve`, { method: 'POST' }),
      ownerClient.request(`/bookings/${second.data.booking.id}/approve`, { method: 'POST' }),
    ]);
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    assert.equal(results.filter((result) => result.status === 409).length, 1);
    const rows = await prisma.booking.findMany({ where: { id: { in: [first.data.booking.id, second.data.booking.id] } } });
    assert.equal(rows.filter((row) => row.status === 'APPROVED').length, 1);
  });

  await t.test('notification reads are private and persist', async () => {
    const ownerNotes = await ownerClient.request('/notifications');
    const note = ownerNotes.data.find((row) => row.bookingId === initialBooking.id);
    assert.ok(note);
    assert.equal((await outsiderClient.request(`/notifications/${note.id}/read`, { method: 'PATCH' })).status, 404);
    assert.equal((await ownerClient.request(`/notifications/${note.id}/read`, { method: 'PATCH' })).status, 200);
    const persisted = await ownerClient.request('/notifications');
    assert.equal(persisted.data.find((row) => row.id === note.id).isRead, true);
    assert.equal((await renterClient.request('/notifications/read-all', { method: 'PATCH' })).status, 200);
  });

  await t.test('Stage 1 registration and external access approval remain intact', async () => {
    const suffix = crypto.randomUUID().slice(0, 12);
    const campusEmail = `  RENTOL-STAGE2-${suffix}@IIITA.AC.IN  `;
    const campus = new Client();
    const direct = await campus.request('/auth/register', { method: 'POST', body: { fullName: 'Stage Two Campus Student', email: campusEmail, password: 'Rental-test-password-932', role: 'ADMIN' } });
    assert.equal(direct.status, 201);
    assert.equal(direct.data.user.email, campusEmail.trim().toLowerCase());
    assert.equal(direct.data.user.role, 'STUDENT');
    assert.equal(direct.data.user.isApproved, true);
    assert.equal((await campus.request('/wishlist')).status, 200);
    const attemptedChange = await campus.request('/profile', { method: 'PATCH', body: { fullName: 'Stage Two Campus Student', email: 'attacker@gmail.com' } });
    assert.equal(attemptedChange.data.user.email, campusEmail.trim().toLowerCase());
    testEmails.push(campusEmail.trim().toLowerCase());

    const externalEmail = `rental-stage2-${suffix}@gmail.com`;
    const external = new Client();
    const requested = await external.request('/auth/register', { method: 'POST', body: { fullName: 'Stage Two External Student', email: externalEmail, password: 'Rental-test-password-932', college: 'Another college', reason: 'Requesting marketplace access for a project.' } });
    assert.equal(requested.status, 202);
    testEmails.push(externalEmail);
    assert.equal((await new Client().request('/auth/login', { method: 'POST', body: { email: externalEmail, password: 'Rental-test-password-932' } })).status, 403);
    const accessRequests = await adminClient.request('/admin/requests');
    const pending = accessRequests.data.find((request) => request.user.email === externalEmail);
    assert.ok(pending);
    assert.equal((await adminClient.request(`/admin/requests/${pending.id}`, { method: 'PATCH', body: { status: 'APPROVED' } })).status, 200);
    assert.equal((await external.request('/auth/login', { method: 'POST', body: { email: externalEmail, password: 'Rental-test-password-932' } })).status, 200);

    const archived = await ownerClient.request(`/listings/${listing.id}`, { method: 'DELETE' });
    assert.equal(archived.status, 200);
    assert.equal(archived.data.archived, true, 'listing deletion preserves rental history');
    assert.equal((await renterClient.request(`/bookings/${initialBooking.id}`)).status, 200);
  });
});
