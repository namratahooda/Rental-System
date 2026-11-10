import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from './auth.js';
import {
  calculateDailyAvailability,
  calculateProposal,
  calculateRentalAmount,
  dateKey,
  isBookingTransitionAllowed,
  parseDateOnly,
  rentalDayCount,
  validateDateRange,
} from './booking-domain.js';

const router = express.Router();
let routerPrisma;
router.use((req, _res, next) => { req.prisma = routerPrisma; next(); });
const RESERVED = ['APPROVED', 'ACTIVE'];
const userView = { select: { id: true, fullName: true, profilePhoto: true, college: true } };
const bookingInclude = {
  listing: { include: { category: true, images: true, owner: { select: { id: true, fullName: true, profilePhoto: true, college: true, department: true, yearOfStudy: true } } } },
  renter: userView,
  owner: userView,
  negotiation: true,
  depositRecord: true,
};
const requestSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  quantity: z.coerce.number().int().min(1).max(99),
  priceUnit: z.enum(['DAILY', 'MONTHLY']).optional(),
  message: z.string().trim().max(500).optional().default(''),
  discountPercentage: z.union([z.literal(10), z.literal(15), z.literal(20)]).optional(),
  negotiationMessage: z.string().trim().max(500).optional().default(''),
});

function dateRange(req, res) {
  const startDate = parseDateOnly(String(req.query.from || ''));
  const endDate = parseDateOnly(String(req.query.to || ''));
  if (!startDate || !endDate || endDate <= startDate) {
    res.status(400).json({ error: 'Choose a valid availability date range.' });
    return null;
  }
  const days = rentalDayCount(startDate, endDate);
  if (days > 100) {
    res.status(400).json({ error: 'Availability can be requested for up to 100 days at a time.' });
    return null;
  }
  return { startDate, endDate, days };
}

async function reservations(client, listingId, startDate, endDate, excludeId) {
  return client.booking.findMany({
    where: {
      listingId,
      status: { in: RESERVED },
      startDate: { lt: endDate },
      endDate: { gt: startDate },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { startDate: true, endDate: true, quantity: true, status: true },
  });
}

async function rangeHasCapacity(client, listing, booking, excludeId) {
  const reserved = await reservations(client, listing.id, booking.startDate, booking.endDate, excludeId);
  const daily = calculateDailyAvailability({
    inventory: listing.quantity,
    bookings: reserved,
    from: dateKey(booking.startDate),
    to: dateKey(booking.endDate),
  });
  return daily.every((day) => day.remaining >= booking.quantity);
}

async function updateBookingState(tx, booking, status, extra = {}) {
  const result = await tx.booking.updateMany({ where: { id: booking.id, status: booking.status }, data: { status, ...extra } });
  if (result.count !== 1) throw Object.assign(new Error('This booking has already changed.'), { statusCode: 409 });
}

function isDatabaseConflict(error) {
  return ['P2034', 'P2028'].includes(error?.code) || /SQLITE_BUSY|database is locked|transaction.*conflict/i.test(String(error?.message || ''));
}

function transactionError(res, error) {
  if (isDatabaseConflict(error)) return res.status(409).json({ error: 'Availability changed while processing. Refresh and try again.' });
  throw error;
}

router.get('/listings/:id/availability', async (req, res, next) => {
  try {
    const range = dateRange(req, res);
    if (!range) return;
    const listing = await req.prisma.listing.findUnique({ where: { id: req.params.id } });
    if (!listing || listing.type !== 'RENT' || listing.status !== 'ACTIVE') return res.status(404).json({ error: 'Rental listing not found.' });
    const bookings = await req.prisma.booking.findMany({
      where: {
        listingId: listing.id,
        status: { in: [...RESERVED, 'PENDING'] },
        startDate: { lt: range.endDate },
        endDate: { gt: range.startDate },
      },
      select: { startDate: true, endDate: true, quantity: true, status: true },
    });
    res.json({ inventory: listing.quantity, days: calculateDailyAvailability({ inventory: listing.quantity, bookings, from: req.query.from, to: req.query.to }) });
  } catch (error) { next(error); }
});

router.post('/booking-key', requireAuth, (_req, res) => {
  res.json({ idempotencyKey: crypto.randomBytes(32).toString('base64url') });
});

router.post('/listings/:id/bookings', requireAuth, async (req, res, next) => {
  try {
    const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{32,100}$/).parse(req.get('Idempotency-Key'));
    const data = requestSchema.parse(req.body);
    const range = validateDateRange(data.startDate, data.endDate);
    if (range.error) return res.status(400).json({ error: range.error });
    if (range.days > 365) return res.status(400).json({ error: 'A rental request cannot exceed 365 days.' });

    const existing = await req.prisma.booking.findUnique({ where: { renterId_idempotencyKey: { renterId: req.user.id, idempotencyKey } }, include: bookingInclude });
    if (existing) return res.status(200).json({ booking: existing, duplicate: true });

    const listing = await req.prisma.listing.findUnique({ where: { id: req.params.id } });
    if (!listing || listing.type !== 'RENT' || listing.status !== 'ACTIVE') return res.status(404).json({ error: 'This rental listing is unavailable.' });
    if (listing.ownerId === req.user.id) return res.status(400).json({ error: 'You cannot book your own listing.' });
    if (data.quantity > listing.quantity) return res.status(400).json({ error: 'Requested quantity exceeds the listing inventory.' });
    const priceUnit = data.priceUnit || (listing.dailyPrice != null ? 'DAILY' : 'MONTHLY');
    let pricing;
    let discountAmount;
    try {
      pricing = calculateRentalAmount({ ...range, quantity: data.quantity, priceUnit, dailyPrice: listing.dailyPrice, monthlyPrice: listing.monthlyPrice });
      discountAmount = data.discountPercentage ? calculateProposal(pricing.amount, data.discountPercentage) : null;
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const booking = await req.prisma.$transaction(async (tx) => {
      const available = await rangeHasCapacity(tx, listing, { ...range, quantity: data.quantity });
      if (!available) throw Object.assign(new Error('The requested dates or quantity are no longer available.'), { statusCode: 409 });
      return tx.booking.create({
        data: {
          listingId: listing.id,
          renterId: req.user.id,
          ownerId: listing.ownerId,
          startDate: range.startDate,
          endDate: range.endDate,
          quantity: data.quantity,
          priceUnit,
          rentalUnits: pricing.rentalUnits,
          originalAmount: pricing.amount,
          agreedAmount: pricing.amount,
          renterMessage: data.message || null,
          idempotencyKey,
          ...(data.discountPercentage ? { negotiation: { create: { proposedDiscountPercentage: data.discountPercentage, proposedAmount: discountAmount, message: data.negotiationMessage || null } } } : {}),
          notifications: { create: { recipientId: listing.ownerId, title: 'New rental request', message: `${req.user.fullName} requested ${data.quantity} unit${data.quantity === 1 ? '' : 's'} of ${listing.title}${data.discountPercentage ? ` with a ${data.discountPercentage}% discount proposal` : ''}.` } },
        },
        include: bookingInclude,
      });
    });
    res.status(201).json({ booking });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error?.code === 'P2002') {
      const key = req.get('Idempotency-Key');
      const existing = await req.prisma.booking.findUnique({ where: { renterId_idempotencyKey: { renterId: req.user.id, idempotencyKey: key } }, include: bookingInclude }).catch(() => null);
      if (existing) return res.status(200).json({ booking: existing, duplicate: true });
      return res.status(409).json({ error: 'This request was already submitted.' });
    }
    if (isDatabaseConflict(error)) return transactionError(res, error);
    next(error);
  }
});

router.get('/bookings', requireAuth, async (req, res, next) => {
  try {
    const where = req.user.role === 'ADMIN'
      ? {}
      : { OR: [{ renterId: req.user.id }, { ownerId: req.user.id }] };
    res.json(await req.prisma.booking.findMany({ where, include: bookingInclude, orderBy: { createdAt: 'desc' } }));
  } catch (error) { next(error); }
});

router.get('/bookings/:id', requireAuth, async (req, res, next) => {
  try {
    const booking = await req.prisma.booking.findUnique({ where: { id: req.params.id }, include: bookingInclude });
    if (!booking || (booking.renterId !== req.user.id && booking.ownerId !== req.user.id && req.user.role !== 'ADMIN')) return res.status(404).json({ error: 'Booking not found.' });
    res.json(booking);
  } catch (error) { next(error); }
});

router.post('/bookings/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const booking = await req.prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUnique({ where: { id: req.params.id }, include: { listing: true, negotiation: true } });
      if (!current) throw Object.assign(new Error('Booking not found.'), { statusCode: 404 });
      if (current.ownerId !== req.user.id && req.user.role !== 'ADMIN') throw Object.assign(new Error('Only the listing owner can approve this request.'), { statusCode: 403 });
      if (!isBookingTransitionAllowed(current.status, 'APPROVED')) throw Object.assign(new Error('Only pending booking requests can be approved.'), { statusCode: 409 });
      if (current.negotiation?.status === 'PENDING') throw Object.assign(new Error('Respond to the discount proposal before approving this request.'), { statusCode: 409 });
      if (!await rangeHasCapacity(tx, current.listing, current, current.id)) throw Object.assign(new Error('These dates or the requested quantity are no longer available.'), { statusCode: 409 });
      const updated = await tx.booking.updateMany({ where: { id: current.id, status: 'PENDING' }, data: { status: 'APPROVED', approvedAt: new Date() } });
      if (updated.count !== 1) throw Object.assign(new Error('This booking has already changed.'), { statusCode: 409 });
      await tx.notification.create({ data: { recipientId: current.renterId, bookingId: current.id, title: 'Rental request approved', message: `Your request for ${current.listing.title} was approved.` } });
      if (current.listing.deposit > 0) await tx.depositRecord.upsert({ where: { bookingId: current.id }, create: { bookingId: current.id, amount: Math.round(current.listing.deposit * current.quantity) }, update: {} });
      return tx.booking.findUnique({ where: { id: current.id }, include: bookingInclude });
    });
    res.json({ booking });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (isDatabaseConflict(error)) return transactionError(res, error);
    next(error);
  }
});

router.post('/bookings/:id/reject', requireAuth, async (req, res, next) => {
  try {
    const booking = await req.prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUnique({ where: { id: req.params.id }, include: { listing: true, depositRecord: true } });
      if (!current) throw Object.assign(new Error('Booking not found.'), { statusCode: 404 });
      if (current.ownerId !== req.user.id && req.user.role !== 'ADMIN') throw Object.assign(new Error('Only the listing owner can reject this request.'), { statusCode: 403 });
      if (!isBookingTransitionAllowed(current.status, 'REJECTED')) throw Object.assign(new Error('Only pending booking requests can be rejected.'), { statusCode: 409 });
      await updateBookingState(tx, current, 'REJECTED');
      await tx.negotiation.updateMany({ where: { bookingId: current.id, status: 'PENDING' }, data: { status: 'REJECTED', respondedAt: new Date() } });
      await tx.notification.create({ data: { recipientId: current.renterId, bookingId: current.id, title: 'Rental request declined', message: `Your request for ${current.listing.title} was declined.` } });
      return tx.booking.findUnique({ where: { id: current.id }, include: bookingInclude });
    });
    res.json({ booking });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message }); if (isDatabaseConflict(error)) return transactionError(res, error); next(error); }
});

router.post('/bookings/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const booking = await req.prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUnique({ where: { id: req.params.id }, include: { listing: true, depositRecord: true } });
      if (!current) throw Object.assign(new Error('Booking not found.'), { statusCode: 404 });
      if (current.renterId !== req.user.id) throw Object.assign(new Error('Only the renter can cancel this booking.'), { statusCode: 403 });
      if (!isBookingTransitionAllowed(current.status, 'CANCELLED')) throw Object.assign(new Error('This booking can no longer be cancelled.'), { statusCode: 409 });
      if (current.status === 'APPROVED' && current.startDate <= new Date()) throw Object.assign(new Error('Approved bookings can only be cancelled before their start date.'), { statusCode: 409 });
      await updateBookingState(tx, current, 'CANCELLED');
      if (current.depositRecord?.status === 'HELD') await tx.depositRecord.update({ where: { bookingId: current.id }, data: { status: 'RETURNED', completedAt: new Date() } });
      await tx.negotiation.updateMany({ where: { bookingId: current.id, status: 'PENDING' }, data: { status: 'CANCELLED', respondedAt: new Date() } });
      await tx.notification.create({ data: { recipientId: current.ownerId, bookingId: current.id, title: 'Rental request cancelled', message: `The renter cancelled their request for ${current.listing.title}.` } });
      return tx.booking.findUnique({ where: { id: current.id }, include: bookingInclude });
    });
    res.json({ booking });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message }); if (isDatabaseConflict(error)) return transactionError(res, error); next(error); }
});

router.post('/bookings/:id/activate', requireAuth, async (req, res, next) => {
  try {
    const booking = await req.prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUnique({ where: { id: req.params.id }, include: { listing: true } });
      if (!current) throw Object.assign(new Error('Booking not found.'), { statusCode: 404 });
      if (current.ownerId !== req.user.id && req.user.role !== 'ADMIN') throw Object.assign(new Error('Only the listing owner can mark this rental active.'), { statusCode: 403 });
      if (!isBookingTransitionAllowed(current.status, 'ACTIVE')) throw Object.assign(new Error('Only approved bookings can be marked active.'), { statusCode: 409 });
      if (current.startDate > new Date()) throw Object.assign(new Error('This rental cannot be marked active before its start date.'), { statusCode: 409 });
      await updateBookingState(tx, current, 'ACTIVE');
      await tx.notification.create({ data: { recipientId: current.renterId, bookingId: current.id, title: 'Rental started', message: `${current.listing.title} has been marked as handed over.` } });
      return tx.booking.findUnique({ where: { id: current.id }, include: bookingInclude });
    });
    res.json({ booking });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message }); if (isDatabaseConflict(error)) return transactionError(res, error); next(error); }
});

router.post('/bookings/:id/complete', requireAuth, async (req, res, next) => {
  try {
    const booking = await req.prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUnique({ where: { id: req.params.id }, include: { listing: true, depositRecord: true } });
      if (!current) throw Object.assign(new Error('Booking not found.'), { statusCode: 404 });
      if (current.ownerId !== req.user.id && req.user.role !== 'ADMIN') throw Object.assign(new Error('Only the listing owner can confirm a return.'), { statusCode: 403 });
      if (!isBookingTransitionAllowed(current.status, 'COMPLETED')) throw Object.assign(new Error('Only active rentals can be completed.'), { statusCode: 409 });
      const now = new Date();
      const depositInput = z.object({ deductionAmount: z.coerce.number().int().min(0).max(2_147_483_647).optional().default(0), deductionReason: z.string().trim().max(500).optional().default('') }).parse(req.body || {});
      if (current.depositRecord && depositInput.deductionAmount > current.depositRecord.amount) throw Object.assign(new Error('Deposit deduction cannot exceed the held deposit.'), { statusCode: 400 });
      if (depositInput.deductionAmount > 0 && !depositInput.deductionReason) throw Object.assign(new Error('Add a reason for the deposit deduction.'), { statusCode: 400 });
      await updateBookingState(tx, current, 'COMPLETED', { completedAt: now });
      if (current.depositRecord) await tx.depositRecord.update({ where: { bookingId: current.id }, data: { deductionAmount: depositInput.deductionAmount, reason: depositInput.deductionReason || null, status: depositInput.deductionAmount > 0 ? 'DEDUCTED' : 'RETURNED', completedAt: now } });
      await tx.notification.create({ data: { recipientId: current.renterId, bookingId: current.id, title: 'Rental returned', message: `${current.listing.title} was marked as returned and complete.` } });
      return tx.booking.findUnique({ where: { id: current.id }, include: bookingInclude });
    });
    res.json({ booking });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message }); if (isDatabaseConflict(error)) return transactionError(res, error); next(error); }
});

router.post('/bookings/:id/negotiations', requireAuth, async (req, res, next) => {
  try {
    const data = z.object({ discountPercentage: z.union([z.literal(10), z.literal(15), z.literal(20)]), message: z.string().trim().max(500).optional().default('') }).parse(req.body);
    const result = await req.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id: req.params.id }, include: { listing: true, negotiation: true } });
      if (!booking) throw Object.assign(new Error('Booking not found.'), { statusCode: 404 });
      if (booking.renterId !== req.user.id) throw Object.assign(new Error('Only the renter can propose a discount.'), { statusCode: 403 });
      if (booking.status !== 'PENDING') throw Object.assign(new Error('Discount proposals are only available for pending bookings.'), { statusCode: 409 });
      if (booking.negotiation) throw Object.assign(new Error('A discount proposal has already been submitted for this booking.'), { statusCode: 409 });
      const proposedAmount = calculateProposal(booking.originalAmount, data.discountPercentage);
      const negotiation = await tx.negotiation.create({ data: { bookingId: booking.id, proposedDiscountPercentage: data.discountPercentage, proposedAmount, message: data.message || null } });
      await tx.notification.create({ data: { recipientId: booking.ownerId, bookingId: booking.id, title: 'Discount proposal received', message: `The renter proposed ${data.discountPercentage}% off for ${booking.listing.title}.` } });
      return negotiation;
    });
    res.status(201).json({ negotiation: result });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message }); if (isDatabaseConflict(error)) return transactionError(res, error); next(error); }
});

router.patch('/bookings/:id/negotiation', requireAuth, async (req, res, next) => {
  try {
    const response = z.enum(['ACCEPTED', 'REJECTED', 'DECLINED']).parse(req.body.response);
    const booking = await req.prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUnique({ where: { id: req.params.id }, include: { listing: true, negotiation: true } });
      if (!current) throw Object.assign(new Error('Booking not found.'), { statusCode: 404 });
      if (current.ownerId !== req.user.id) throw Object.assign(new Error('Only the listing owner can respond to this proposal.'), { statusCode: 403 });
      if (current.renterId === req.user.id) throw Object.assign(new Error('The renter cannot respond to their own proposal.'), { statusCode: 403 });
      if (current.status !== 'PENDING' || current.negotiation?.status !== 'PENDING') throw Object.assign(new Error('There is no pending proposal to respond to.'), { statusCode: 409 });
      const changed = await tx.negotiation.updateMany({ where: { bookingId: current.id, status: 'PENDING' }, data: { status: response, respondedAt: new Date() } });
      if (changed.count !== 1) throw Object.assign(new Error('This proposal has already received a response.'), { statusCode: 409 });
      if (response === 'ACCEPTED') {
        const amountChanged = await tx.booking.updateMany({ where: { id: current.id, status: 'PENDING' }, data: { agreedAmount: current.negotiation.proposedAmount } });
        if (amountChanged.count !== 1) throw Object.assign(new Error('This booking has already changed.'), { statusCode: 409 });
      }
      const label = response === 'ACCEPTED' ? 'accepted' : response === 'DECLINED' ? 'declined; the original price remains' : 'rejected';
      await tx.notification.create({ data: { recipientId: current.renterId, bookingId: current.id, title: `Discount proposal ${label}`, message: `The owner ${label} your discount proposal for ${current.listing.title}.` } });
      return tx.booking.findUnique({ where: { id: current.id }, include: bookingInclude });
    });
    res.json({ booking });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message }); if (isDatabaseConflict(error)) return transactionError(res, error); next(error); }
});

router.get('/notifications', requireAuth, async (req, res, next) => {
  try {
    const notifications = await req.prisma.notification.findMany({
      where: { recipientId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: { booking: { select: { id: true, status: true, listing: { select: { title: true } } } }, purchaseRequest: { select: { id: true } }, membership: { select: { id: true } }, transaction: { select: { id: true } }, conversation: { select: { id: true } } },
    });
    res.json(notifications);
  } catch (error) { next(error); }
});

router.patch('/notifications/read-all', requireAuth, async (req, res, next) => {
  try {
    const result = await req.prisma.notification.updateMany({ where: { recipientId: req.user.id, isRead: false }, data: { isRead: true } });
    res.json({ updated: result.count });
  } catch (error) { next(error); }
});

router.patch('/notifications/:id/read', requireAuth, async (req, res, next) => {
  try {
    const result = await req.prisma.notification.updateMany({ where: { id: req.params.id, recipientId: req.user.id }, data: { isRead: true } });
    if (!result.count) return res.status(404).json({ error: 'Notification not found.' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

export function createBookingRouter(prisma) {
  routerPrisma = prisma;
  return router;
}
