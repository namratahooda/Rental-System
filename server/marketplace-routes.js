import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { requireAdmin, requireAuth } from './auth.js';

const router = express.Router();
let db;
router.use((req, _res, next) => { req.prisma = db; next(); });

const userSummary = { select: { id: true, fullName: true, profilePhoto: true, college: true } };
const purchaseInclude = {
  listing: { include: { category: true, images: true, owner: userSummary } },
  buyer: userSummary,
  seller: userSummary,
  offers: { orderBy: { createdAt: 'asc' } },
  transactions: { orderBy: { createdAt: 'desc' } },
};
const subscriptionInclude = { category: true, owner: userSummary };
const membershipInclude = { listing: { include: subscriptionInclude }, user: userSummary, transactions: { orderBy: { createdAt: 'desc' } } };
const refundPeopleInclude = { requestedBy: userSummary, approvedBy: userSummary, rejectedBy: userSummary, processedBy: userSummary };
const transactionInclude = { purchaseRequest: { include: purchaseInclude }, membership: { include: membershipInclude }, refunds: { orderBy: { requestedAt: 'desc' }, include: refundPeopleInclude } };

function failure(status, message) { return Object.assign(new Error(message), { statusCode: status }); }
function sendError(res, next, error) {
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
  if (error?.code === 'P2002') return res.status(409).json({ error: 'This marketplace action has already been recorded.' });
  if (['P2034', 'P2028'].includes(error?.code) || /SQLITE_BUSY|database is locked|transaction.*conflict/i.test(String(error?.message || ''))) return res.status(409).json({ error: 'Marketplace availability changed while processing. Refresh and try again.' });
  next(error);
}
function dayDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}
function dateString(value) { return new Date(value).toISOString().slice(0, 10); }
function amount(value) { return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647; }
function notify(tx, recipientId, title, message, links = {}) {
  return tx.notification.create({ data: { recipientId, title, message, ...links } });
}
function paymentStatus(outcome) { return ({ SUCCESS: 'SUCCESS', FAILED: 'FAILED', CANCELLED: 'CANCELLED' })[outcome]; }

async function expireMemberships(client) {
  const due = await client.subscriptionMembership.findMany({ where: { status: 'ACTIVE', expiryDate: { lte: new Date() } }, select: { id: true, listingId: true, userId: true, listing: { select: { name: true } } } });
  for (const membership of due) {
    await client.$transaction(async (tx) => {
      const changed = await tx.subscriptionMembership.updateMany({ where: { id: membership.id, status: 'ACTIVE', expiryDate: { lte: new Date() } }, data: { status: 'EXPIRED' } });
      if (!changed.count) return;
      await tx.subscriptionListing.updateMany({ where: { id: membership.listingId, availableSeats: { lt: (await tx.subscriptionListing.findUnique({ where: { id: membership.listingId }, select: { totalSeats: true } }))?.totalSeats ?? 0 } }, data: { availableSeats: { increment: 1 } } });
      await notify(tx, membership.userId, 'Subscription expired', `Your ${membership.listing.name} membership has expired.`, { membershipId: membership.id });
    });
  }
}

router.get('/purchases', requireAuth, async (req, res, next) => {
  try {
    const side = req.query.side === 'seller' ? 'seller' : 'buyer';
    const where = side === 'seller' ? { sellerId: req.user.id } : { buyerId: req.user.id };
    res.json(await req.prisma.purchaseRequest.findMany({ where, include: purchaseInclude, orderBy: { createdAt: 'desc' } }));
  } catch (error) { next(error); }
});

router.post('/listings/:id/purchases', requireAuth, async (req, res, next) => {
  try {
    const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{32,100}$/).parse(req.get('Idempotency-Key'));
    const body = z.object({ message: z.string().trim().max(500).optional().default('') }).parse(req.body);
    const existing = await req.prisma.purchaseRequest.findUnique({ where: { buyerId_idempotencyKey: { buyerId: req.user.id, idempotencyKey } }, include: purchaseInclude });
    if (existing) return res.status(200).json({ request: existing, duplicate: true });
    const result = await req.prisma.$transaction(async (tx) => {
      const listing = await tx.listing.findUnique({ where: { id: req.params.id }, include: { owner: true } });
      if (!listing || listing.type !== 'SELL' || listing.status !== 'ACTIVE' || listing.quantity < 1) throw failure(404, 'This item is not available for purchase.');
      if (listing.ownerId === req.user.id) throw failure(400, 'You cannot purchase your own listing.');
      const existingRequest = await tx.purchaseRequest.findFirst({ where: { listingId: listing.id, buyerId: req.user.id, status: { in: ['PENDING', 'ACCEPTED', 'PAYMENT_PENDING'] } } });
      if (existingRequest) throw failure(409, 'You already have an active request for this item.');
      const price = Math.round(Number(listing.salePrice));
      if (!amount(price)) throw failure(409, 'The seller has not set a valid asking price.');
      const request = await tx.purchaseRequest.create({ data: { listingId: listing.id, buyerId: req.user.id, sellerId: listing.ownerId, originalAmount: price, agreedAmount: price, message: body.message || null, idempotencyKey }, include: purchaseInclude });
      await notify(tx, listing.ownerId, 'New purchase request', `${req.user.fullName} requested to purchase ${listing.title}.`, { purchaseRequestId: request.id });
      return request;
    });
    res.status(201).json({ request: result });
  } catch (error) {
    if (error?.code === 'P2002' && req.get('Idempotency-Key')) {
      const request = await req.prisma.purchaseRequest.findUnique({ where: { buyerId_idempotencyKey: { buyerId: req.user.id, idempotencyKey: req.get('Idempotency-Key') } }, include: purchaseInclude }).catch(() => null);
      if (request) return res.status(200).json({ request, duplicate: true });
    }
    sendError(res, next, error);
  }
});

router.get('/purchases/:id', requireAuth, async (req, res, next) => {
  try {
    const request = await req.prisma.purchaseRequest.findUnique({ where: { id: req.params.id }, include: purchaseInclude });
    if (!request || (request.buyerId !== req.user.id && request.sellerId !== req.user.id && req.user.role !== 'ADMIN')) return res.status(404).json({ error: 'Purchase request not found.' });
    res.json(request);
  } catch (error) { next(error); }
});

router.post('/purchases/:id/accept', requireAuth, async (req, res, next) => {
  try {
    const request = await req.prisma.$transaction(async (tx) => {
      const current = await tx.purchaseRequest.findUnique({ where: { id: req.params.id }, include: { listing: true } });
      if (!current) throw failure(404, 'Purchase request not found.');
      if (current.sellerId !== req.user.id && req.user.role !== 'ADMIN') throw failure(403, 'Only the seller can accept this request.');
      if (current.status !== 'PENDING') throw failure(409, 'Only pending purchase requests can be accepted.');
      if (current.listing.status !== 'ACTIVE' || current.listing.quantity < 1) throw failure(409, 'This item is no longer available.');
      const reserved = await tx.purchaseRequest.count({ where: { listingId: current.listingId, status: { in: ['ACCEPTED', 'PAYMENT_PENDING'] } } });
      if (reserved >= current.listing.quantity) throw failure(409, 'The remaining item quantity is already reserved for another buyer.');
      const changed = await tx.purchaseRequest.updateMany({ where: { id: current.id, status: 'PENDING' }, data: { status: 'ACCEPTED' } });
      if (!changed.count) throw failure(409, 'This request has already changed.');
      await notify(tx, current.buyerId, 'Purchase request accepted', `The seller accepted your request for ${current.listing.title}.`, { purchaseRequestId: current.id });
      return tx.purchaseRequest.findUnique({ where: { id: current.id }, include: purchaseInclude });
    });
    res.json({ request });
  } catch (error) { sendError(res, next, error); }
});

router.post('/purchases/:id/reject', requireAuth, async (req, res, next) => {
  try {
    const request = await req.prisma.$transaction(async (tx) => {
      const current = await tx.purchaseRequest.findUnique({ where: { id: req.params.id }, include: { listing: true } });
      if (!current) throw failure(404, 'Purchase request not found.');
      if (current.sellerId !== req.user.id && req.user.role !== 'ADMIN') throw failure(403, 'Only the seller can reject this request.');
      if (!['PENDING', 'ACCEPTED'].includes(current.status)) throw failure(409, 'This request can no longer be rejected.');
      await tx.purchaseRequest.updateMany({ where: { id: current.id, status: current.status }, data: { status: 'REJECTED' } });
      await tx.transaction.updateMany({ where: { purchaseRequestId: current.id, status: 'INITIATED' }, data: { status: 'CANCELLED' } });
      await notify(tx, current.buyerId, 'Purchase request rejected', `Your request for ${current.listing.title} was rejected.`, { purchaseRequestId: current.id });
      return tx.purchaseRequest.findUnique({ where: { id: current.id }, include: purchaseInclude });
    });
    res.json({ request });
  } catch (error) { sendError(res, next, error); }
});

router.post('/purchases/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const request = await req.prisma.$transaction(async (tx) => {
      const current = await tx.purchaseRequest.findUnique({ where: { id: req.params.id }, include: { listing: true } });
      if (!current) throw failure(404, 'Purchase request not found.');
      if (current.buyerId !== req.user.id) throw failure(403, 'Only the buyer can cancel this request.');
      if (!['PENDING', 'ACCEPTED', 'PAYMENT_PENDING'].includes(current.status)) throw failure(409, 'This purchase request can no longer be cancelled.');
      await tx.purchaseRequest.updateMany({ where: { id: current.id, status: current.status }, data: { status: 'CANCELLED' } });
      await tx.transaction.updateMany({ where: { purchaseRequestId: current.id, status: 'INITIATED' }, data: { status: 'CANCELLED' } });
      await notify(tx, current.sellerId, 'Purchase request cancelled', `The buyer cancelled their request for ${current.listing.title}.`, { purchaseRequestId: current.id });
      return tx.purchaseRequest.findUnique({ where: { id: current.id }, include: purchaseInclude });
    });
    res.json({ request });
  } catch (error) { sendError(res, next, error); }
});

router.post('/purchases/:id/offers', requireAuth, async (req, res, next) => {
  try {
    const data = z.object({ proposedAmount: z.coerce.number().int().positive().max(2_147_483_647), message: z.string().trim().max(500).optional().default('') }).parse(req.body);
    const offer = await req.prisma.$transaction(async (tx) => {
      const current = await tx.purchaseRequest.findUnique({ where: { id: req.params.id }, include: { listing: true, offers: true } });
      if (!current) throw failure(404, 'Purchase request not found.');
      if (current.buyerId !== req.user.id) throw failure(403, 'Only the buyer can propose a price.');
      if (!['PENDING', 'ACCEPTED'].includes(current.status)) throw failure(409, 'Price proposals are no longer available for this request.');
      if (data.proposedAmount >= current.originalAmount) throw failure(400, 'A proposal must be lower than the asking price.');
      if (current.offerCount >= 3) throw failure(409, 'The maximum of three price proposals has been reached.');
      if (current.offers.some((offerRow) => offerRow.status === 'PENDING')) throw failure(409, 'Wait for the seller to respond to the current proposal.');
      const created = await tx.purchaseOffer.create({ data: { requestId: current.id, proposedAmount: data.proposedAmount, message: data.message || null } });
      await tx.purchaseRequest.update({ where: { id: current.id }, data: { offerCount: { increment: 1 } } });
      await notify(tx, current.sellerId, 'Price proposal received', `The buyer proposed ₹${data.proposedAmount} for ${current.listing.title}.`, { purchaseRequestId: current.id });
      return created;
    });
    res.status(201).json({ offer });
  } catch (error) { sendError(res, next, error); }
});

router.patch('/purchases/:id/offers/:offerId', requireAuth, async (req, res, next) => {
  try {
    const response = z.enum(['ACCEPTED', 'REJECTED']).parse(req.body.response);
    const request = await req.prisma.$transaction(async (tx) => {
      const current = await tx.purchaseRequest.findUnique({ where: { id: req.params.id }, include: { listing: true } });
      if (!current) throw failure(404, 'Purchase request not found.');
      if (current.sellerId !== req.user.id) throw failure(403, 'Only the seller can respond to a price proposal.');
      if (!['PENDING', 'ACCEPTED'].includes(current.status)) throw failure(409, 'This purchase request is no longer open to negotiation.');
      const offer = await tx.purchaseOffer.findUnique({ where: { id: req.params.offerId } });
      if (!offer || offer.requestId !== current.id) throw failure(404, 'Price proposal not found.');
      const updated = await tx.purchaseOffer.updateMany({ where: { id: offer.id, status: 'PENDING' }, data: { status: response, respondedAt: new Date() } });
      if (!updated.count) throw failure(409, 'This proposal has already received a response.');
      if (response === 'ACCEPTED') await tx.purchaseRequest.update({ where: { id: current.id }, data: { agreedAmount: offer.proposedAmount } });
      await notify(tx, current.buyerId, response === 'ACCEPTED' ? 'Price proposal accepted' : 'Price proposal rejected', response === 'ACCEPTED' ? `The seller accepted ₹${offer.proposedAmount} for ${current.listing.title}.` : `The seller rejected your proposal for ${current.listing.title}; the asking price remains.`, { purchaseRequestId: current.id });
      return tx.purchaseRequest.findUnique({ where: { id: current.id }, include: purchaseInclude });
    });
    res.json({ request });
  } catch (error) { sendError(res, next, error); }
});

router.get('/subscriptions/categories', async (_req, res, next) => {
  try { res.json(await reqPrisma(_req).subscriptionCategory.findMany({ where: { active: true }, orderBy: { name: 'asc' } })); }
  catch (error) { next(error); }
});
function reqPrisma(req) { return req.prisma; }

router.get('/subscriptions', async (req, res, next) => {
  try {
    await expireMemberships(req.prisma);
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || '');
    const min = req.query.minPrice === undefined ? undefined : Number(req.query.minPrice);
    const max = req.query.maxPrice === undefined ? undefined : Number(req.query.maxPrice);
    if ((min !== undefined && (!Number.isFinite(min) || min < 0)) || (max !== undefined && (!Number.isFinite(max) || max < 0))) return res.status(400).json({ error: 'Price filters must be non-negative numbers.' });
    const where = { status: 'ACTIVE', expiryDate: { gt: new Date() }, availableSeats: req.query.available === 'true' ? { gt: 0 } : undefined, ...(category ? { category: { slug: category, active: true } } : {}), ...(q ? { name: { contains: q } } : {}), ...(min !== undefined || max !== undefined ? { pricePerSeat: { ...(min !== undefined ? { gte: min } : {}), ...(max !== undefined ? { lte: max } : {}) } } : {}) };
    res.json(await req.prisma.subscriptionListing.findMany({ where, include: subscriptionInclude, orderBy: { createdAt: 'desc' } }));
  } catch (error) { next(error); }
});
router.get('/subscriptions/mine', requireAuth, async (req, res, next) => {
  try { res.json(await req.prisma.subscriptionListing.findMany({ where: { ownerId: req.user.id }, include: subscriptionInclude, orderBy: { createdAt: 'desc' } })); }
  catch (error) { next(error); }
});
router.get('/subscriptions/memberships', requireAuth, async (req, res, next) => {
  try {
    await expireMemberships(req.prisma);
    res.json(await req.prisma.subscriptionMembership.findMany({ where: { OR: [{ userId: req.user.id }, { listing: { ownerId: req.user.id } }] }, include: membershipInclude, orderBy: { createdAt: 'desc' } }));
  } catch (error) { next(error); }
});

router.get('/subscriptions/:id', async (req, res, next) => {
  try {
    const listing = await req.prisma.subscriptionListing.findUnique({ where: { id: req.params.id }, include: subscriptionInclude });
    if (!listing || listing.status === 'REMOVED' || (listing.status === 'PAUSED' && listing.ownerId !== req.user?.id) || listing.expiryDate <= new Date()) return res.status(404).json({ error: 'Subscription listing not found.' });
    res.json(listing);
  } catch (error) { next(error); }
});

const subscriptionInput = z.object({ categoryId: z.string().min(1), name: z.string().trim().min(2).max(100), description: z.string().trim().min(5).max(3000), plan: z.string().trim().min(2).max(120), totalSeats: z.coerce.number().int().min(1).max(500), durationDays: z.coerce.number().int().min(1).max(3650), startDate: z.string(), expiryDate: z.string(), pricePerSeat: z.coerce.number().int().positive().max(2_147_483_647), restrictions: z.string().trim().max(1000).optional().nullable(), terms: z.string().trim().max(2000).optional().nullable() });
router.post('/subscriptions', requireAuth, async (req, res, next) => {
  try {
    const data = subscriptionInput.parse(req.body);
    const startDate = dayDate(data.startDate), expiryDate = dayDate(data.expiryDate);
    if (!startDate || !expiryDate || expiryDate <= startDate) return res.status(400).json({ error: 'Expiry date must be after a valid start date.' });
    if (expiryDate <= new Date()) return res.status(400).json({ error: 'Expiry date must be in the future.' });
    if (!await req.prisma.subscriptionCategory.findFirst({ where: { id: data.categoryId, active: true } })) return res.status(400).json({ error: 'Choose an active subscription category.' });
    const listing = await req.prisma.subscriptionListing.create({ data: { ...data, ownerId: req.user.id, startDate, expiryDate, availableSeats: data.totalSeats }, include: subscriptionInclude });
    res.status(201).json(listing);
  } catch (error) { sendError(res, next, error); }
});

router.patch('/subscriptions/:id', requireAuth, async (req, res, next) => {
  try {
    const current = await req.prisma.subscriptionListing.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ error: 'Subscription listing not found.' });
    if (current.ownerId !== req.user.id && req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Only the owner can update this listing.' });
    if (req.body.status !== undefined) {
      const status = z.enum(['ACTIVE', 'PAUSED', 'REMOVED']).parse(req.body.status);
      return res.json(await req.prisma.subscriptionListing.update({ where: { id: current.id }, data: { status }, include: subscriptionInclude }));
    }
    const data = subscriptionInput.partial().parse(req.body);
    await expireMemberships(req.prisma);
    const updated = await req.prisma.$transaction(async (tx) => {
      const fresh = await tx.subscriptionListing.findUnique({ where: { id: req.params.id } });
      if (!fresh) throw failure(404, 'Subscription listing not found.');
      if (fresh.ownerId !== req.user.id && req.user.role !== 'ADMIN') throw failure(403, 'Only the owner can update this listing.');
      const allocated = await tx.subscriptionMembership.count({ where: { listingId: fresh.id, status: { in: ['APPROVED', 'PAYMENT_PENDING', 'ACTIVE'] } } });
      const totalSeats = data.totalSeats ?? fresh.totalSeats;
      if (totalSeats < allocated) throw failure(409, 'Total seats cannot be less than seats already allocated.');
      const startDate = data.startDate ? dayDate(data.startDate) : fresh.startDate;
      const expiryDate = data.expiryDate ? dayDate(data.expiryDate) : fresh.expiryDate;
      if (!startDate || !expiryDate || expiryDate <= startDate) throw failure(400, 'Expiry date must be after a valid start date.');
      if (data.categoryId && !await tx.subscriptionCategory.findFirst({ where: { id: data.categoryId, active: true } })) throw failure(400, 'Choose an active subscription category.');
      return tx.subscriptionListing.update({ where: { id: fresh.id }, data: { ...data, startDate, expiryDate, totalSeats, availableSeats: totalSeats - allocated }, include: subscriptionInclude });
    });
    res.json(updated);
  } catch (error) { sendError(res, next, error); }
});

router.post('/subscriptions/:id/requests', requireAuth, async (req, res, next) => {
  try {
    const message = z.string().trim().max(500).optional().parse(req.body.message) || null;
    const membership = await req.prisma.$transaction(async (tx) => {
      const listing = await tx.subscriptionListing.findUnique({ where: { id: req.params.id } });
      if (!listing || listing.status !== 'ACTIVE' || listing.expiryDate <= new Date()) throw failure(404, 'Subscription is no longer accepting requests.');
      if (listing.ownerId === req.user.id) throw failure(400, 'You cannot join your own subscription listing.');
      if (listing.availableSeats < 1) throw failure(409, 'No subscription seats remain.');
      const old = await tx.subscriptionMembership.findFirst({ where: { listingId: listing.id, userId: req.user.id }, orderBy: { createdAt: 'desc' } });
      if (old && ['PENDING', 'APPROVED', 'PAYMENT_PENDING', 'ACTIVE'].includes(old.status)) throw failure(409, 'You already have an active request or membership for this subscription.');
      const data = { listingId: listing.id, userId: req.user.id, amount: listing.pricePerSeat, startDate: listing.startDate > new Date() ? listing.startDate : new Date(), expiryDate: listing.expiryDate, status: 'PENDING', message };
      const created = old ? await tx.subscriptionMembership.update({ where: { id: old.id }, data }) : await tx.subscriptionMembership.create({ data });
      await notify(tx, listing.ownerId, 'New subscription seat request', `${req.user.fullName} requested a seat in ${listing.name}.`, { membershipId: created.id });
      return tx.subscriptionMembership.findUnique({ where: { id: created.id }, include: membershipInclude });
    });
    res.status(201).json({ membership });
  } catch (error) { sendError(res, next, error); }
});

router.post('/subscriptions/memberships/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const membership = await req.prisma.$transaction(async (tx) => {
      const current = await tx.subscriptionMembership.findUnique({ where: { id: req.params.id }, include: { listing: true } });
      if (!current) throw failure(404, 'Seat request not found.');
      if (current.listing.ownerId !== req.user.id && req.user.role !== 'ADMIN') throw failure(403, 'Only the subscription owner can approve seat requests.');
      if (current.status !== 'PENDING') throw failure(409, 'Only pending seat requests can be approved.');
      if (current.listing.expiryDate <= new Date()) throw failure(409, 'This subscription has expired.');
      const seat = await tx.subscriptionListing.updateMany({ where: { id: current.listingId, status: 'ACTIVE', availableSeats: { gt: 0 } }, data: { availableSeats: { decrement: 1 } } });
      if (!seat.count) throw failure(409, 'No seats remain.');
      const updated = await tx.subscriptionMembership.updateMany({ where: { id: current.id, status: 'PENDING' }, data: { status: 'APPROVED' } });
      if (!updated.count) throw failure(409, 'This request has already changed.');
      await notify(tx, current.userId, 'Subscription seat approved', `Your request to join ${current.listing.name} was approved. Complete the simulated payment to activate it.`, { membershipId: current.id });
      return tx.subscriptionMembership.findUnique({ where: { id: current.id }, include: membershipInclude });
    });
    res.json({ membership });
  } catch (error) { sendError(res, next, error); }
});

router.post('/subscriptions/memberships/:id/reject', requireAuth, async (req, res, next) => {
  try {
    const membership = await req.prisma.$transaction(async (tx) => {
      const current = await tx.subscriptionMembership.findUnique({ where: { id: req.params.id }, include: { listing: true } });
      if (!current) throw failure(404, 'Seat request not found.');
      if (current.listing.ownerId !== req.user.id && req.user.role !== 'ADMIN') throw failure(403, 'Only the subscription owner can reject seat requests.');
      const changed = await tx.subscriptionMembership.updateMany({ where: { id: current.id, status: 'PENDING' }, data: { status: 'REJECTED' } });
      if (!changed.count) throw failure(409, 'Only pending seat requests can be rejected.');
      await notify(tx, current.userId, 'Subscription request rejected', `Your request to join ${current.listing.name} was rejected.`, { membershipId: current.id });
      return tx.subscriptionMembership.findUnique({ where: { id: current.id }, include: membershipInclude });
    });
    res.json({ membership });
  } catch (error) { sendError(res, next, error); }
});

router.post('/subscriptions/memberships/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const membership = await req.prisma.$transaction(async (tx) => {
      const current = await tx.subscriptionMembership.findUnique({ where: { id: req.params.id }, include: { listing: true } });
      if (!current) throw failure(404, 'Membership not found.');
      if (current.userId !== req.user.id) throw failure(403, 'Only the member can cancel this request.');
      if (!['PENDING', 'APPROVED', 'PAYMENT_PENDING'].includes(current.status)) throw failure(409, 'This membership can no longer be cancelled.');
      const changed = await tx.subscriptionMembership.updateMany({ where: { id: current.id, status: current.status }, data: { status: 'CANCELLED' } });
      if (!changed.count) throw failure(409, 'This membership has already changed.');
      if (['APPROVED', 'PAYMENT_PENDING'].includes(current.status)) await tx.subscriptionListing.updateMany({ where: { id: current.listingId, availableSeats: { lt: current.listing.totalSeats } }, data: { availableSeats: { increment: 1 } } });
      await tx.transaction.updateMany({ where: { membershipId: current.id, status: 'INITIATED' }, data: { status: 'CANCELLED' } });
      await notify(tx, current.listing.ownerId, 'Subscription request cancelled', `${req.user.fullName} cancelled their request for ${current.listing.name}.`, { membershipId: current.id });
      return tx.subscriptionMembership.findUnique({ where: { id: current.id }, include: membershipInclude });
    });
    res.json({ membership });
  } catch (error) { sendError(res, next, error); }
});

router.post('/subscriptions/expire', requireAuth, requireAdmin, async (req, res, next) => {
  try { await expireMemberships(req.prisma); res.json({ ok: true }); }
  catch (error) { next(error); }
});

router.post('/transactions/key', requireAuth, (_req, res) => res.json({ idempotencyKey: crypto.randomBytes(32).toString('base64url') }));
router.get('/transactions', requireAuth, async (req, res, next) => {
  try { res.json(await req.prisma.transaction.findMany({ where: { userId: req.user.id }, include: transactionInclude, orderBy: { createdAt: 'desc' } })); }
  catch (error) { next(error); }
});
router.get('/transactions/received', requireAuth, async (req, res, next) => {
  try {
    res.json(await req.prisma.transaction.findMany({ where: { OR: [{ purchaseRequest: { sellerId: req.user.id } }, { membership: { listing: { ownerId: req.user.id } } }] }, include: transactionInclude, orderBy: { createdAt: 'desc' } }));
  } catch (error) { next(error); }
});
router.get('/transactions/:id', requireAuth, async (req, res, next) => {
  try {
    const transaction = await req.prisma.transaction.findUnique({ where: { id: req.params.id }, include: transactionInclude });
    const relatedOwner = transaction?.purchaseRequest?.sellerId || transaction?.membership?.listing.ownerId;
    if (!transaction || (transaction.userId !== req.user.id && relatedOwner !== req.user.id && req.user.role !== 'ADMIN')) return res.status(404).json({ error: 'Transaction not found.' });
    res.json(transaction);
  } catch (error) { next(error); }
});

router.post('/transactions', requireAuth, async (req, res, next) => {
  try {
    const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{32,100}$/).parse(req.get('Idempotency-Key'));
    const data = z.object({ purchaseRequestId: z.string().optional(), membershipId: z.string().optional() }).refine((value) => Boolean(value.purchaseRequestId) !== Boolean(value.membershipId), 'Choose one supported checkout item.').parse(req.body);
    const duplicate = await req.prisma.transaction.findUnique({ where: { userId_idempotencyKey: { userId: req.user.id, idempotencyKey } }, include: transactionInclude });
    if (duplicate) return res.status(200).json({ transaction: duplicate, duplicate: true });
    const transaction = await req.prisma.$transaction(async (tx) => {
      let type, amountDue, purchaseRequestId = null, membershipId = null;
      if (data.purchaseRequestId) {
        const purchase = await tx.purchaseRequest.findUnique({ where: { id: data.purchaseRequestId }, include: { listing: true } });
        if (!purchase || purchase.buyerId !== req.user.id) throw failure(404, 'Purchase request not found.');
        if (!['ACCEPTED', 'PAYMENT_PENDING'].includes(purchase.status) || purchase.listing.status !== 'ACTIVE') throw failure(409, 'This purchase is not ready for payment.');
        type = 'PURCHASE'; amountDue = purchase.agreedAmount; purchaseRequestId = purchase.id;
        if (purchase.status === 'ACCEPTED') await tx.purchaseRequest.update({ where: { id: purchase.id }, data: { status: 'PAYMENT_PENDING' } });
      } else {
        const membership = await tx.subscriptionMembership.findUnique({ where: { id: data.membershipId }, include: { listing: true } });
        if (!membership || membership.userId !== req.user.id) throw failure(404, 'Subscription membership not found.');
        if (!['APPROVED', 'PAYMENT_PENDING'].includes(membership.status)) throw failure(409, 'This subscription is not ready for payment.');
        type = 'SUBSCRIPTION'; amountDue = membership.amount; membershipId = membership.id;
        if (membership.status === 'APPROVED') await tx.subscriptionMembership.update({ where: { id: membership.id }, data: { status: 'PAYMENT_PENDING' } });
      }
      if (!amount(amountDue)) throw failure(409, 'The amount due is invalid.');
      const openAttempt = await tx.transaction.findFirst({ where: { userId: req.user.id, status: 'INITIATED', ...(purchaseRequestId ? { purchaseRequestId } : { membershipId }) }, orderBy: { createdAt: 'desc' } });
      if (openAttempt) return openAttempt;
      return tx.transaction.create({ data: { userId: req.user.id, purchaseRequestId, membershipId, type, amount: amountDue, idempotencyKey } });
    });
    res.status(201).json({ transaction });
  } catch (error) { sendError(res, next, error); }
});

router.post('/transactions/:id/resolve', requireAuth, async (req, res, next) => {
  try {
    const outcome = z.enum(['SUCCESS', 'FAILED', 'CANCELLED']).parse(req.body.outcome);
    const transaction = await req.prisma.$transaction(async (tx) => {
      const current = await tx.transaction.findUnique({ where: { id: req.params.id }, include: { purchaseRequest: { include: { listing: true } }, membership: { include: { listing: true } } } });
      if (!current || current.userId !== req.user.id) throw failure(404, 'Transaction not found.');
      if (current.status !== 'INITIATED') {
        if (current.status === outcome) return tx.transaction.findUnique({ where: { id: current.id }, include: transactionInclude });
        throw failure(409, 'This transaction has already been resolved.');
      }
      if (outcome !== 'SUCCESS') {
        await tx.transaction.update({ where: { id: current.id }, data: { status: outcome } });
        if (current.membershipId) {
          const changed = await tx.subscriptionMembership.updateMany({ where: { id: current.membershipId, status: 'PAYMENT_PENDING' }, data: { status: 'CANCELLED' } });
          if (changed.count) await tx.subscriptionListing.updateMany({ where: { id: current.membership.listingId, availableSeats: { lt: current.membership.listing.totalSeats } }, data: { availableSeats: { increment: 1 } } });
        }
        await notify(tx, current.userId, `Simulated payment ${outcome.toLowerCase()}`, `Transaction ${current.id} was recorded as ${outcome.toLowerCase()}. No real payment was processed.`, { transactionId: current.id, ...(current.purchaseRequestId ? { purchaseRequestId: current.purchaseRequestId } : {}), ...(current.membershipId ? { membershipId: current.membershipId } : {}) });
        return tx.transaction.findUnique({ where: { id: current.id }, include: transactionInclude });
      }
      if (current.purchaseRequestId) {
        const purchase = current.purchaseRequest;
        if (!purchase || purchase.status !== 'PAYMENT_PENDING' || purchase.listing.status !== 'ACTIVE') throw failure(409, 'This item is no longer available for payment.');
        const changed = await tx.listing.updateMany({ where: { id: purchase.listingId, type: 'SELL', status: 'ACTIVE', quantity: { gt: 0 } }, data: { quantity: { decrement: 1 } } });
        if (!changed.count) throw failure(409, 'The item has already been sold.');
        const listing = await tx.listing.findUnique({ where: { id: purchase.listingId } });
        if (listing.quantity === 0) {
          await tx.listing.update({ where: { id: listing.id }, data: { status: 'SOLD' } });
          const siblings = await tx.purchaseRequest.findMany({ where: { listingId: listing.id, id: { not: purchase.id }, status: { in: ['PENDING', 'ACCEPTED', 'PAYMENT_PENDING'] } }, select: { id: true, buyerId: true } });
          if (siblings.length) {
            const siblingIds = siblings.map((sibling) => sibling.id);
            await tx.purchaseRequest.updateMany({ where: { id: { in: siblingIds } }, data: { status: 'REJECTED' } });
            await tx.transaction.updateMany({ where: { purchaseRequestId: { in: siblingIds }, status: 'INITIATED' }, data: { status: 'CANCELLED' } });
            for (const sibling of siblings) await notify(tx, sibling.buyerId, 'Purchase request unavailable', `${listing.title} was sold before this request could be completed.`, { purchaseRequestId: sibling.id });
          }
        }
        await tx.purchaseRequest.update({ where: { id: purchase.id }, data: { status: 'COMPLETED' } });
        await tx.transaction.updateMany({ where: { purchaseRequestId: purchase.id, id: { not: current.id }, status: 'INITIATED' }, data: { status: 'CANCELLED' } });
        await notify(tx, purchase.sellerId, 'Purchase completed', `The buyer completed the simulated purchase of ${listing.title}.`, { purchaseRequestId: purchase.id, transactionId: current.id });
      } else if (current.membershipId) {
        const membership = current.membership;
        if (!membership || membership.status !== 'PAYMENT_PENDING' || membership.expiryDate <= new Date()) throw failure(409, 'This subscription is no longer available for activation.');
        const changed = await tx.subscriptionMembership.updateMany({ where: { id: membership.id, status: 'PAYMENT_PENDING' }, data: { status: 'ACTIVE' } });
        if (!changed.count) throw failure(409, 'This membership has already changed.');
        await tx.transaction.updateMany({ where: { membershipId: membership.id, id: { not: current.id }, status: 'INITIATED' }, data: { status: 'CANCELLED' } });
        await notify(tx, membership.userId, 'Subscription membership active', `Your ${membership.listing.name} membership is active until ${dateString(membership.expiryDate)}. Rentol does not change external provider accounts.`, { membershipId: membership.id, transactionId: current.id });
        await notify(tx, membership.listing.ownerId, 'Subscription seat activated', `A seat in ${membership.listing.name} is now active.`, { membershipId: membership.id, transactionId: current.id });
      }
      await tx.transaction.update({ where: { id: current.id }, data: { status: 'SUCCESS' } });
      await notify(tx, current.userId, 'Simulated payment successful', `Transaction ${current.id} was recorded successfully. No real payment was processed.`, { transactionId: current.id, ...(current.purchaseRequestId ? { purchaseRequestId: current.purchaseRequestId } : {}), ...(current.membershipId ? { membershipId: current.membershipId } : {}) });
      return tx.transaction.findUnique({ where: { id: current.id }, include: transactionInclude });
    });
    res.json({ transaction });
  } catch (error) { sendError(res, next, error); }
});

router.post('/transactions/:id/refund', requireAuth, async (req, res, next) => {
  try {
    const data = z.object({ amount: z.coerce.number().int().positive().max(2_147_483_647), reason: z.string().trim().min(3).max(500) }).parse(req.body);
    const refund = await req.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUnique({ where: { id: req.params.id }, include: { purchaseRequest: true, membership: { include: { listing: true } } } });
      if (!transaction || transaction.userId !== req.user.id) throw failure(404, 'Transaction not found.');
      if (!['SUCCESS', 'PARTIALLY_REFUNDED'].includes(transaction.status)) throw failure(409, 'Only successful transactions can be refunded.');
      const previous = await tx.refund.aggregate({ where: { transactionId: transaction.id, status: { in: ['REQUESTED', 'APPROVED', 'PROCESSED'] } }, _sum: { amount: true } });
      if (data.amount + (previous._sum.amount || 0) > transaction.amount) throw failure(400, 'Total refund requests cannot exceed the transaction amount.');
      const created = await tx.refund.create({ data: { transactionId: transaction.id, requestedById: req.user.id, amount: data.amount, reason: data.reason } });
      await tx.transaction.update({ where: { id: transaction.id }, data: { status: 'REFUND_PENDING' } });
      const recipient = transaction.purchaseRequest?.sellerId || transaction.membership?.listing.ownerId;
      if (recipient) await notify(tx, recipient, 'Refund requested', `A refund of ₹${data.amount} was requested for transaction ${transaction.id}.`, { transactionId: transaction.id });
      return created;
    });
    res.status(201).json({ refund });
  } catch (error) { sendError(res, next, error); }
});

async function reviewRefund(req, res, next) {
  try {
    const action = z.enum(['APPROVED', 'REJECTED', 'PROCESSED']).parse(req.body.status);
    const rejectionReason = action === 'REJECTED' ? z.string().trim().min(3).max(500).parse(req.body.rejectionReason) : null;
    const refund = await req.prisma.$transaction(async (tx) => {
      const current = await tx.refund.findUnique({
        where: { id: req.params.id },
        include: { transaction: { include: { purchaseRequest: true, membership: { include: { listing: true } } } } },
      });
      if (!current) throw failure(404, 'Refund request not found.');
      const ownerId = current.transaction.purchaseRequest?.sellerId || current.transaction.membership?.listing.ownerId || null;
      const authorized = req.user.role === 'ADMIN' || ownerId === req.user.id;
      if (!authorized || current.requestedById === req.user.id) throw failure(403, 'Only the related listing owner or an administrator may review another user’s refund request.');
      const allowed = current.status === 'REQUESTED' ? ['APPROVED', 'REJECTED'] : current.status === 'APPROVED' ? ['PROCESSED'] : [];
      if (!allowed.includes(action)) throw failure(409, 'Invalid refund status transition.');
      const now = new Date();
      const data = action === 'APPROVED'
        ? { status: action, approvedById: req.user.id, approvedAt: now }
        : action === 'REJECTED'
          ? { status: action, rejectedById: req.user.id, rejectedAt: now, rejectionReason }
          : { status: action, processedById: req.user.id, processedAt: now };
      const changed = await tx.refund.updateMany({ where: { id: current.id, status: current.status }, data });
      if (!changed.count) throw failure(409, 'This refund request has already changed.');
      if (action === 'PROCESSED' || action === 'REJECTED') {
        const pending = await tx.refund.count({ where: { transactionId: current.transactionId, status: { in: ['REQUESTED', 'APPROVED'] } } });
        const processedAmount = await tx.refund.aggregate({ where: { transactionId: current.transactionId, status: 'PROCESSED' }, _sum: { amount: true } });
        const paidBack = processedAmount._sum.amount || 0;
        const nextStatus = pending ? 'REFUND_PENDING' : paidBack >= current.transaction.amount ? 'REFUNDED' : paidBack > 0 ? 'PARTIALLY_REFUNDED' : 'SUCCESS';
        await tx.transaction.update({ where: { id: current.transactionId }, data: { status: nextStatus } });
      }
      const verb = action === 'APPROVED' ? 'approved' : action === 'REJECTED' ? 'rejected' : 'marked processed';
      const reasonText = rejectionReason ? ` Reason: ${rejectionReason}` : '';
      await notify(tx, current.requestedById, `Simulated refund ${action.toLowerCase()}`, `Your simulated refund request for transaction ${current.transactionId} was ${verb}.${reasonText}`, { transactionId: current.transactionId });
      return tx.refund.findUnique({ where: { id: current.id }, include: refundPeopleInclude });
    });
    res.json({ refund });
  } catch (error) { sendError(res, next, error); }
}
router.patch('/refunds/:id', requireAuth, reviewRefund);
router.patch('/admin/refunds/:id', requireAuth, reviewRefund);
router.get('/admin/refunds', requireAuth, requireAdmin, async (req, res, next) => {
  try { res.json(await req.prisma.refund.findMany({ include: { ...refundPeopleInclude, transaction: { include: transactionInclude } }, orderBy: { requestedAt: 'desc' } })); }
  catch (error) { next(error); }
});

router.get('/users/:id/reviews', async (req, res, next) => {
  try {
    const reviews = await req.prisma.review.findMany({ where: { reviewedUserId: req.params.id, status: 'VISIBLE' }, include: { reviewer: userSummary }, orderBy: { createdAt: 'desc' } });
    res.json({ average: reviews.length ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length : null, count: reviews.length, reviews });
  } catch (error) { next(error); }
});
router.get('/reviews/mine', requireAuth, async (req, res, next) => {
  try { res.json(await req.prisma.review.findMany({ where: { reviewerId: req.user.id }, include: { reviewedUser: userSummary, purchaseRequest: { include: { listing: true } }, booking: { include: { listing: true } }, subscriptionMembership: { include: { listing: true } } }, orderBy: { createdAt: 'desc' } })); }
  catch (error) { next(error); }
});
router.post('/reviews', requireAuth, async (req, res, next) => {
  try {
    const data = z.object({ interactionType: z.enum(['PURCHASE', 'SUBSCRIPTION', 'RENTAL']), interactionId: z.string().min(1), rating: z.coerce.number().int().min(1).max(5), comment: z.string().trim().max(1000).optional().default('') }).parse(req.body);
    if (data.interactionType === 'SUBSCRIPTION') await expireMemberships(req.prisma);
    const review = await req.prisma.$transaction(async (tx) => {
      let key, reviewedUserId, relation = {};
      if (data.interactionType === 'PURCHASE') {
        const purchase = await tx.purchaseRequest.findUnique({ where: { id: data.interactionId } });
        if (!purchase || purchase.status !== 'COMPLETED' || purchase.buyerId !== req.user.id) throw failure(403, 'Only the buyer in a completed purchase can review the seller.');
        key = `PURCHASE:${purchase.id}`; reviewedUserId = purchase.sellerId; relation.purchaseRequestId = purchase.id;
      } else if (data.interactionType === 'SUBSCRIPTION') {
        const membership = await tx.subscriptionMembership.findUnique({ where: { id: data.interactionId }, include: { listing: true } });
        if (!membership || membership.status !== 'EXPIRED' || membership.userId !== req.user.id) throw failure(403, 'Only a member whose subscription period has ended can review the subscription owner.');
        key = `SUBSCRIPTION:${membership.id}`; reviewedUserId = membership.listing.ownerId; relation.subscriptionMembershipId = membership.id;
      } else {
        const booking = await tx.booking.findUnique({ where: { id: data.interactionId } });
        if (!booking || booking.status !== 'COMPLETED' || ![booking.renterId, booking.ownerId].includes(req.user.id)) throw failure(403, 'Only participants in a completed rental can review each other.');
        key = `RENTAL:${booking.id}:${req.user.id}`; reviewedUserId = booking.renterId === req.user.id ? booking.ownerId : booking.renterId; relation.bookingId = booking.id;
      }
      if (reviewedUserId === req.user.id) throw failure(400, 'You cannot review your own account.');
      const created = await tx.review.create({ data: { reviewerId: req.user.id, reviewedUserId, interactionKey: key, rating: data.rating, comment: data.comment || null, ...relation } });
      await notify(tx, reviewedUserId, 'New marketplace review', `${req.user.fullName} left you a ${data.rating}-star review.`, {});
      return created;
    });
    res.status(201).json({ review });
  } catch (error) { sendError(res, next, error); }
});
router.patch('/admin/reviews/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const status = z.enum(['VISIBLE', 'HIDDEN']).parse(req.body.status);
    res.json({ review: await req.prisma.review.update({ where: { id: req.params.id }, data: { status } }) });
  } catch (error) { sendError(res, next, error); }
});

async function getConversation(req, conversationId) {
  const conversation = await req.prisma.conversation.findUnique({ where: { id: conversationId }, include: { participants: { include: { user: userSummary } }, relatedListing: { select: { id: true, title: true, status: true } }, subscriptionListing: { select: { id: true, name: true, status: true } }, purchaseRequest: { select: { id: true, listingId: true } } } });
  if (!conversation || !conversation.participants.some((participant) => participant.userId === req.user.id)) throw failure(404, 'Conversation not found.');
  return conversation;
}
router.get('/conversations', requireAuth, async (req, res, next) => {
  try {
    const rows = await req.prisma.conversation.findMany({ where: { participants: { some: { userId: req.user.id } } }, include: { participants: { include: { user: userSummary } }, relatedListing: { select: { id: true, title: true, status: true } }, subscriptionListing: { select: { id: true, name: true, status: true } }, purchaseRequest: { select: { id: true, listingId: true } }, messages: { orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: { updatedAt: 'desc' } });
    res.json(await Promise.all(rows.map(async (row) => ({ ...row, unreadCount: await req.prisma.message.count({ where: { conversationId: row.id, senderId: { not: req.user.id }, readAt: null } }) }))));
  } catch (error) { next(error); }
});
router.post('/conversations', requireAuth, async (req, res, next) => {
  try {
    const data = z.object({ listingId: z.string().optional(), purchaseRequestId: z.string().optional(), subscriptionListingId: z.string().optional() }).refine((value) => [value.listingId, value.purchaseRequestId, value.subscriptionListingId].filter(Boolean).length === 1, 'Choose one related listing or request.').parse(req.body);
    let recipientId, keyPart, key, createContext = {};
    if (data.purchaseRequestId) {
      const request = await req.prisma.purchaseRequest.findUnique({ where: { id: data.purchaseRequestId } });
      if (!request || ![request.buyerId, request.sellerId].includes(req.user.id)) return res.status(404).json({ error: 'Purchase request not found.' });
      recipientId = request.buyerId === req.user.id ? request.sellerId : request.buyerId; keyPart = `purchase:${request.id}`; createContext = { purchaseRequestId: request.id, relatedListingId: request.listingId };
    } else if (data.subscriptionListingId) {
      const listing = await req.prisma.subscriptionListing.findUnique({ where: { id: data.subscriptionListingId } });
      if (!listing || listing.status === 'REMOVED' || (listing.status === 'PAUSED' && listing.ownerId !== req.user.id)) return res.status(404).json({ error: 'Subscription listing not found.' });
      recipientId = listing.ownerId; keyPart = `subscription:${listing.id}`; createContext = { subscriptionListingId: listing.id };
    } else {
      const listing = await req.prisma.listing.findUnique({ where: { id: data.listingId } });
      if (!listing || listing.status === 'REMOVED' || listing.status === 'SOLD' || (listing.status === 'PAUSED' && listing.ownerId !== req.user.id)) return res.status(404).json({ error: 'Listing not found.' });
      recipientId = listing.ownerId; keyPart = `listing:${listing.id}`; createContext = { relatedListingId: listing.id };
    }
    if (recipientId === req.user.id) return res.status(400).json({ error: 'You cannot message yourself.' });
    key = `${keyPart}:${[req.user.id, recipientId].sort().join(':')}`;
    const conversation = await req.prisma.$transaction(async (tx) => {
      let row = await tx.conversation.findUnique({ where: { key } });
      if (!row) row = await tx.conversation.create({ data: { key, ...createContext, participants: { create: [{ userId: req.user.id }, { userId: recipientId }] } } });
      return tx.conversation.findUnique({ where: { id: row.id }, include: { participants: { include: { user: userSummary } }, relatedListing: { select: { id: true, title: true } }, subscriptionListing: { select: { id: true, name: true } } } });
    });
    res.status(201).json({ conversation });
  } catch (error) {
    if (error?.code === 'P2002' && key) {
      const conversation = await req.prisma.conversation.findUnique({ where: { key }, include: { participants: { include: { user: userSummary } }, relatedListing: { select: { id: true, title: true } }, subscriptionListing: { select: { id: true, name: true } } } }).catch(() => null);
      if (conversation) return res.status(200).json({ conversation, duplicate: true });
    }
    sendError(res, next, error);
  }
});
router.get('/conversations/:id/messages', requireAuth, async (req, res, next) => {
  try { await getConversation(req, req.params.id); res.json(await req.prisma.message.findMany({ where: { conversationId: req.params.id }, include: { sender: userSummary }, orderBy: { createdAt: 'asc' } })); }
  catch (error) { sendError(res, next, error); }
});
router.post('/conversations/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
    const message = await req.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id: req.params.id }, include: { participants: true } });
      if (!conversation || !conversation.participants.some((participant) => participant.userId === req.user.id)) throw failure(404, 'Conversation not found.');
      const created = await tx.message.create({ data: { conversationId: conversation.id, senderId: req.user.id, text } });
      await tx.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
      const recipientId = conversation.participants.find((participant) => participant.userId !== req.user.id)?.userId;
      if (recipientId) {
        await notify(tx, recipientId, 'New message', `${req.user.fullName} sent you a message.`, { conversationId: conversation.id });
      }
      return tx.message.findUnique({ where: { id: created.id }, include: { sender: userSummary } });
    });
    res.status(201).json({ message });
  } catch (error) { sendError(res, next, error); }
});
router.patch('/conversations/:id/read', requireAuth, async (req, res, next) => {
  try {
    await getConversation(req, req.params.id);
    const result = await req.prisma.message.updateMany({ where: { conversationId: req.params.id, senderId: { not: req.user.id }, readAt: null }, data: { readAt: new Date() } });
    res.json({ updated: result.count });
  } catch (error) { sendError(res, next, error); }
});

router.get('/admin/subscription-categories', requireAuth, requireAdmin, async (req, res, next) => {
  try { res.json(await req.prisma.subscriptionCategory.findMany({ orderBy: { name: 'asc' } })); } catch (error) { next(error); }
});
router.post('/admin/subscription-categories', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const name = z.string().trim().min(2).max(80).parse(req.body.name);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    res.status(201).json(await req.prisma.subscriptionCategory.create({ data: { name, slug } }));
  } catch (error) { sendError(res, next, error); }
});

export function createMarketplaceRouter(prisma) { db = prisma; return router; }
