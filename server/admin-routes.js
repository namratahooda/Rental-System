import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth, publicUser } from './auth.js';

const userSelect = { id: true, fullName: true, email: true, role: true, isApproved: true, suspended: true, college: true, createdAt: true, accessRequest: true, _count: { select: { listings: true, renterBookings: true, ownerBookings: true, transactions: true, subscriptionMemberships: true } } };
const listingInclude = { category: true, owner: { select: { id: true, fullName: true, email: true } }, _count: { select: { bookings: true, purchaseRequests: true, reports: true } } };
const reportInclude = { reporter: { select: { id: true, fullName: true, email: true } }, reportedUser: { select: { id: true, fullName: true, email: true } }, listing: { select: { id: true, title: true, ownerId: true } }, subscriptionListing: { select: { id: true, name: true, ownerId: true } }, transaction: { select: { id: true, type: true, amount: true, status: true, userId: true } }, reviewedBy: { select: { id: true, fullName: true, email: true } } };
const targetSchema = z.object({ listingId: z.string().optional(), reportedUserId: z.string().optional(), subscriptionListingId: z.string().optional(), transactionId: z.string().optional() });
const reportSchema = z.object({ reason: z.string().trim().min(3).max(100), description: z.string().trim().min(10).max(2000) }).merge(targetSchema).superRefine((value, ctx) => {
  const targets = ['listingId', 'reportedUserId', 'subscriptionListingId', 'transactionId'].filter((key) => value[key]);
  if (targets.length !== 1) ctx.addIssue({ code: 'custom', message: 'Choose exactly one item, user, or transaction to report.' });
});

const writeAudit = (tx, adminId, data) => tx.auditLog.create({ data: { administratorId: adminId, ...data } });
const countOverRange = async (tx, model, where) => tx[model].count({ where });

export function createAdminRouter(prisma) {
  const router = Router();

  const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).default(0) });
  const bookingView = { listing: { select: { id: true, title: true, images: { take: 1 }, category: { select: { name: true } } } }, renter: { select: { id: true, fullName: true } }, owner: { select: { id: true, fullName: true } }, negotiation: true, depositRecord: true };
  const purchaseView = { listing: { select: { id: true, title: true, images: { take: 1 } } }, buyer: { select: { id: true, fullName: true } }, seller: { select: { id: true, fullName: true } }, offers: { orderBy: { createdAt: 'desc' }, take: 5 }, transactions: { orderBy: { createdAt: 'desc' }, take: 5 } };
  const membershipView = { listing: { include: { owner: { select: { id: true, fullName: true } }, category: true } }, user: { select: { id: true, fullName: true } }, transactions: { orderBy: { createdAt: 'desc' }, take: 5 } };
  router.get('/dashboard/summary', requireAuth, async (req, res, next) => {
    try {
      const id = req.user.id;
      const [activeRentals, approvedRentals, completedRentals, pendingRentalRequests, pendingPurchases, completedPurchases, pendingMemberships, activeMemberships, unreadMessages, unreadNotifications, incomingBookings, incomingPurchases, incomingMembershipRequests, pendingReturns, pendingRefunds] = await Promise.all([
        prisma.booking.count({ where: { renterId: id, status: 'ACTIVE' } }),
        prisma.booking.count({ where: { renterId: id, status: 'APPROVED' } }),
        prisma.booking.count({ where: { renterId: id, status: 'COMPLETED' } }),
        prisma.booking.count({ where: { renterId: id, status: 'PENDING' } }),
        prisma.purchaseRequest.count({ where: { buyerId: id, status: { in: ['PENDING', 'ACCEPTED', 'PAYMENT_PENDING'] } } }),
        prisma.purchaseRequest.count({ where: { buyerId: id, status: 'COMPLETED' } }),
        prisma.subscriptionMembership.count({ where: { userId: id, status: { in: ['PENDING', 'APPROVED', 'PAYMENT_PENDING'] } } }),
        prisma.subscriptionMembership.count({ where: { userId: id, status: 'ACTIVE' } }),
        prisma.message.count({ where: { readAt: null, senderId: { not: id }, conversation: { participants: { some: { userId: id } } } } }),
        prisma.notification.count({ where: { recipientId: id, isRead: false } }),
        prisma.booking.count({ where: { ownerId: id, status: 'PENDING' } }),
        prisma.purchaseRequest.count({ where: { sellerId: id, status: 'PENDING' } }),
        prisma.subscriptionMembership.count({ where: { listing: { ownerId: id }, status: 'PENDING' } }),
        prisma.booking.count({ where: { ownerId: id, status: 'ACTIVE' } }),
        prisma.refund.count({ where: { status: 'REQUESTED', transaction: { OR: [{ purchaseRequest: { sellerId: id } }, { membership: { listing: { ownerId: id } } }] } } }),
      ]);
      const [rentalActivity, incomingRequests] = await Promise.all([
        prisma.booking.findMany({ where: { renterId: id, status: { in: ['ACTIVE', 'APPROVED', 'COMPLETED'] } }, include: bookingView, orderBy: { updatedAt: 'desc' }, take: 5 }),
        prisma.booking.findMany({ where: { ownerId: id, status: 'PENDING' }, include: bookingView, orderBy: { createdAt: 'desc' }, take: 5 }),
      ]);
      res.json({ counts: { activeRentals, approvedRentals, completedRentals, pendingRentalRequests, pendingPurchases, completedPurchases, pendingMemberships, activeMemberships, unreadMessages, unreadNotifications, incomingBookings, incomingPurchases, incomingMembershipRequests, pendingReturns, pendingRefunds, importantActions: incomingBookings + incomingPurchases + incomingMembershipRequests + pendingRefunds }, rentalActivity, incomingRequests });
    } catch (error) { next(error); }
  });
  router.get('/dashboard/buyer', requireAuth, async (req, res, next) => {
    try {
      const { limit, offset } = pageSchema.parse(req.query); const id = req.user.id;
      const [purchases, rentals, memberships, transactions, reviews, conversations, counts] = await Promise.all([
        prisma.purchaseRequest.findMany({ where: { buyerId: id }, include: purchaseView, orderBy: { updatedAt: 'desc' }, take: limit, skip: offset }),
        prisma.booking.findMany({ where: { renterId: id }, include: bookingView, orderBy: { updatedAt: 'desc' }, take: limit, skip: offset }),
        prisma.subscriptionMembership.findMany({ where: { userId: id }, include: membershipView, orderBy: { updatedAt: 'desc' }, take: limit, skip: offset }),
        prisma.transaction.findMany({ where: { userId: id }, include: { refunds: { select: { id: true, amount: true, status: true, requestedAt: true } }, purchaseRequest: { select: { listing: { select: { title: true } } } }, membership: { select: { listing: { select: { name: true } } } } }, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
        prisma.review.findMany({ where: { reviewerId: id }, include: { reviewedUser: { select: { fullName: true } } }, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
        prisma.conversation.findMany({ where: { participants: { some: { userId: id } } }, include: { relatedListing: { select: { id: true, title: true } }, subscriptionListing: { select: { id: true, name: true } }, _count: { select: { messages: true } } }, orderBy: { updatedAt: 'desc' }, take: limit, skip: offset }),
        Promise.all([prisma.purchaseRequest.count({ where: { buyerId: id } }), prisma.booking.count({ where: { renterId: id } }), prisma.subscriptionMembership.count({ where: { userId: id } }), prisma.transaction.count({ where: { userId: id } }), prisma.review.count({ where: { reviewerId: id } })]),
      ]);
      res.json({ purchases, rentals, memberships, transactions, reviews, conversations, counts: { purchases: counts[0], rentals: counts[1], memberships: counts[2], transactions: counts[3], reviews: counts[4] }, page: { limit, offset, hasMore: [counts[0], counts[1], counts[2], counts[3], counts[4]].some((total) => offset + limit < total) } });
    } catch (error) { next(error); }
  });
  router.get('/dashboard/seller', requireAuth, async (req, res, next) => {
    try {
      const { limit, offset } = pageSchema.parse(req.query); const id = req.user.id;
      const [listings, subscriptions, purchases, rentals, memberships, transactions, reviews, conversations, counts] = await Promise.all([
        prisma.listing.findMany({ where: { ownerId: id }, include: { category: true, images: { take: 1 } }, orderBy: { updatedAt: 'desc' }, take: limit, skip: offset }),
        prisma.subscriptionListing.findMany({ where: { ownerId: id }, include: { category: true, _count: { select: { memberships: true } } }, orderBy: { updatedAt: 'desc' }, take: limit, skip: offset }),
        prisma.purchaseRequest.findMany({ where: { sellerId: id }, include: purchaseView, orderBy: { updatedAt: 'desc' }, take: limit, skip: offset }),
        prisma.booking.findMany({ where: { ownerId: id }, include: bookingView, orderBy: { updatedAt: 'desc' }, take: limit, skip: offset }),
        prisma.subscriptionMembership.findMany({ where: { listing: { ownerId: id } }, include: membershipView, orderBy: { updatedAt: 'desc' }, take: limit, skip: offset }),
        prisma.transaction.findMany({ where: { OR: [{ purchaseRequest: { sellerId: id } }, { membership: { listing: { ownerId: id } } }] }, include: { refunds: { select: { id: true, amount: true, status: true, requestedAt: true } }, purchaseRequest: { select: { listing: { select: { title: true } } } }, membership: { select: { listing: { select: { name: true } } } } }, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
        prisma.review.findMany({ where: { reviewedUserId: id }, include: { reviewer: { select: { fullName: true } } }, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
        prisma.conversation.findMany({ where: { participants: { some: { userId: id } } }, include: { relatedListing: { select: { id: true, title: true } }, subscriptionListing: { select: { id: true, name: true } }, purchaseRequest: { select: { id: true, listing: { select: { title: true } } } } }, orderBy: { updatedAt: 'desc' }, take: limit, skip: offset }),
        Promise.all([prisma.listing.count({ where: { ownerId: id } }), prisma.subscriptionListing.count({ where: { ownerId: id } }), prisma.purchaseRequest.count({ where: { sellerId: id } }), prisma.booking.count({ where: { ownerId: id } }), prisma.subscriptionMembership.count({ where: { listing: { ownerId: id } } }), prisma.review.count({ where: { reviewedUserId: id } }), prisma.conversation.count({ where: { participants: { some: { userId: id } } } })]),
      ]);
      res.json({ listings, subscriptions, purchases, rentals, memberships, transactions, reviews, conversations, counts: { listings: counts[0], subscriptions: counts[1], purchases: counts[2], rentals: counts[3], memberships: counts[4], reviews: counts[5], conversations: counts[6] }, page: { limit, offset, hasMore: [counts[0], counts[1], counts[2], counts[3], counts[4], counts[5], counts[6]].some((total) => offset + limit < total) } });
    } catch (error) { next(error); }
  });

  router.post('/reports', requireAuth, async (req, res, next) => {
    try {
      const data = reportSchema.parse(req.body);
      if (data.reportedUserId === req.user.id) return res.status(400).json({ error: 'You cannot report your own account.' });
      if (data.listingId) {
        const item = await prisma.listing.findUnique({ where: { id: data.listingId }, select: { id: true, ownerId: true } });
        if (!item) return res.status(404).json({ error: 'Listing not found.' });
        data.reportedUserId = item.ownerId;
      }
      if (data.subscriptionListingId) {
        const item = await prisma.subscriptionListing.findUnique({ where: { id: data.subscriptionListingId }, select: { id: true, ownerId: true } });
        if (!item) return res.status(404).json({ error: 'Subscription listing not found.' });
        data.reportedUserId = item.ownerId;
      }
      if (data.reportedUserId === req.user.id) return res.status(400).json({ error: 'You cannot report your own account or listing.' });
      if (data.transactionId && !await prisma.transaction.findFirst({ where: { id: data.transactionId, userId: req.user.id }, select: { id: true } })) return res.status(404).json({ error: 'Transaction not found.' });
      if (data.reportedUserId && !await prisma.user.findUnique({ where: { id: data.reportedUserId }, select: { id: true } })) return res.status(404).json({ error: 'User not found.' });
      const report = await prisma.marketplaceReport.create({ data: { ...data, reporterId: req.user.id }, include: reportInclude });
      res.status(201).json(report);
    } catch (error) { next(error); }
  });
  router.get('/reports/mine', requireAuth, async (req, res, next) => {
    try { res.json(await prisma.marketplaceReport.findMany({ where: { reporterId: req.user.id }, include: reportInclude, orderBy: { createdAt: 'desc' } })); }
    catch (error) { next(error); }
  });

  router.use('/admin', requireAuth, requireAdmin);
  router.get('/admin/stats', async (_req, res, next) => {
    try {
      const [users, pendingRequests, suspendedUsers, rentListings, saleListings] = await Promise.all([
        prisma.user.count(), prisma.externalAccessRequest.count({ where: { status: 'PENDING' } }), prisma.user.count({ where: { suspended: true } }),
        prisma.listing.count({ where: { type: 'RENT', status: 'ACTIVE', category: { slug: { not: 'subscriptions' } } } }), prisma.listing.count({ where: { type: 'SELL', status: 'ACTIVE', category: { slug: { not: 'subscriptions' } } } }),
      ]);
      res.json({ users, pendingRequests, suspendedUsers, rentListings, saleListings, activeListings: rentListings + saleListings });
    } catch (error) { next(error); }
  });
  router.get('/admin/users', async (_req, res, next) => {
    try { res.json((await prisma.user.findMany({ select: userSelect, orderBy: { createdAt: 'desc' } })).map((user) => ({ ...publicUser(user), institutional: user.email.toLowerCase().endsWith('@iiita.ac.in') }))); }
    catch (error) { next(error); }
  });
  router.get('/admin/users/:id', async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: userSelect });
      if (!user) return res.status(404).json({ error: 'User not found.' });
      const [recentBookings, recentTransactions, recentListings] = await Promise.all([
        prisma.booking.findMany({ where: { OR: [{ renterId: user.id }, { ownerId: user.id }] }, include: { listing: { select: { id: true, title: true } } }, orderBy: { createdAt: 'desc' }, take: 10 }),
        prisma.transaction.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, type: true, amount: true, status: true, createdAt: true } }),
        prisma.listing.findMany({ where: { ownerId: user.id }, include: { category: true }, orderBy: { createdAt: 'desc' }, take: 10 }),
      ]);
      res.json({ ...publicUser(user), institutional: user.email.toLowerCase().endsWith('@iiita.ac.in'), recentBookings, recentTransactions, recentListings });
    } catch (error) { next(error); }
  });
  router.get('/admin/requests', async (_req, res, next) => {
    try { res.json(await prisma.externalAccessRequest.findMany({ include: { user: { select: { id: true, fullName: true, email: true, college: true, createdAt: true } } }, orderBy: { createdAt: 'desc' } })); }
    catch (error) { next(error); }
  });
  router.patch('/admin/requests/:id', async (req, res, next) => {
    try {
      const status = z.enum(['APPROVED', 'REJECTED']).parse(req.body.status);
      const found = await prisma.externalAccessRequest.findUnique({ where: { id: req.params.id }, include: { user: true } });
      if (!found) return res.status(404).json({ error: 'Access request not found.' });
      if (found.status !== 'PENDING') return res.status(409).json({ error: 'This access request has already been reviewed.' });
      const result = await prisma.$transaction(async (tx) => {
        const request = await tx.externalAccessRequest.update({ where: { id: found.id }, data: { status, reviewedAt: new Date(), user: { update: { isApproved: status === 'APPROVED' } } }, include: { user: true } });
        await writeAudit(tx, req.user.id, { actionType: `ACCESS_${status}`, entityType: 'ExternalAccessRequest', entityId: found.id, description: `${status === 'APPROVED' ? 'Approved' : 'Rejected'} external access for ${found.user.email}.`, beforeStatus: found.status, afterStatus: status });
        return request;
      });
      res.json({ request: result, user: publicUser(result.user) });
    } catch (error) { next(error); }
  });
  router.patch('/admin/users/:id/status', async (req, res, next) => {
    try {
      const { suspended, reason = '' } = z.object({ suspended: z.boolean(), reason: z.string().trim().max(300).optional() }).parse(req.body);
      if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot suspend your own account.' });
      const target = await prisma.user.findUnique({ where: { id: req.params.id }, include: { accessRequest: true } });
      if (!target) return res.status(404).json({ error: 'User not found.' });
      if (!suspended && target.accessRequest && target.accessRequest.status !== 'APPROVED') return res.status(409).json({ error: 'Pending or rejected access requests must be approved through Access requests.' });
      if (target.role === 'ADMIN' && suspended) {
        const available = await prisma.user.count({ where: { role: 'ADMIN', suspended: false, isApproved: true } });
        if (available <= 1) return res.status(409).json({ error: 'The last active administrator cannot be suspended.' });
      }
      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.update({ where: { id: target.id }, data: { suspended } });
        await writeAudit(tx, req.user.id, { actionType: suspended ? 'USER_SUSPENDED' : 'USER_REACTIVATED', entityType: 'User', entityId: target.id, description: `${suspended ? 'Suspended' : 'Reactivated'} ${target.email}${reason ? `: ${reason}` : '.'}`, beforeStatus: target.suspended ? 'SUSPENDED' : 'ACTIVE', afterStatus: suspended ? 'SUSPENDED' : 'ACTIVE' });
        return user;
      });
      res.json(publicUser(result));
    } catch (error) { next(error); }
  });
  router.get('/admin/listings', async (req, res, next) => {
    try {
      const where = { ...(req.query.status ? { status: z.enum(['ACTIVE', 'PAUSED', 'REMOVED', 'SOLD']).parse(String(req.query.status)) } : {}), ...(req.query.type ? { type: z.enum(['RENT', 'SELL']).parse(String(req.query.type)) } : {}), ...(req.query.category ? { categoryId: String(req.query.category) } : {}) };
      res.json(await prisma.listing.findMany({ where, include: listingInclude, orderBy: { createdAt: 'desc' } }));
    } catch (error) { next(error); }
  });
  router.patch('/admin/listings/:id/moderation', async (req, res, next) => {
    try {
      const { status, reason = '' } = z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'REMOVED']), reason: z.string().trim().max(300).optional() }).parse(req.body);
      const existing = await prisma.listing.findUnique({ where: { id: req.params.id }, select: { id: true, status: true, title: true, type: true } });
      if (!existing) return res.status(404).json({ error: 'Listing not found.' });
      if (existing.status === 'SOLD' && status !== 'SOLD') return res.status(409).json({ error: 'Sold listings cannot be restored or changed by moderation.' });
      const result = await prisma.$transaction(async (tx) => {
        const listing = await tx.listing.update({ where: { id: existing.id }, data: { status }, include: listingInclude });
        await writeAudit(tx, req.user.id, { actionType: 'LISTING_MODERATED', entityType: 'Listing', entityId: existing.id, description: `Changed “${existing.title}” from ${existing.status} to ${status}${reason ? `: ${reason}` : '.'}`, beforeStatus: existing.status, afterStatus: status });
        return listing;
      });
      res.json(result);
    } catch (error) { next(error); }
  });
  router.get('/admin/categories', async (_req, res, next) => { try { res.json(await prisma.category.findMany({ orderBy: { name: 'asc' } })); } catch (error) { next(error); } });
  router.patch('/admin/categories/:id', async (req, res, next) => {
    try {
      const data = z.object({ name: z.string().trim().min(2).max(60).optional(), active: z.boolean().optional() }).refine((value) => value.name !== undefined || value.active !== undefined).parse(req.body);
      const old = await prisma.category.findUnique({ where: { id: req.params.id } });
      if (!old || old.slug === 'subscriptions') return res.status(404).json({ error: 'Category not found.' });
      const updated = await prisma.$transaction(async (tx) => {
        const category = await tx.category.update({ where: { id: old.id }, data: { ...data, ...(data.name ? { slug: data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') } : {}) } });
        await writeAudit(tx, req.user.id, { actionType: 'CATEGORY_UPDATED', entityType: 'Category', entityId: old.id, description: `Updated category “${old.name}”.`, beforeStatus: old.active ? 'ACTIVE' : 'INACTIVE', afterStatus: category.active ? 'ACTIVE' : 'INACTIVE' });
        return category;
      });
      res.json(updated);
    } catch (error) { next(error); }
  });
  router.get('/admin/bookings', async (req, res, next) => {
    try {
      const status = req.query.status ? z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ACTIVE', 'COMPLETED']).parse(String(req.query.status)) : undefined;
      res.json(await prisma.booking.findMany({ where: status ? { status } : {}, include: { listing: { select: { id: true, title: true } }, renter: { select: { id: true, fullName: true, email: true } }, owner: { select: { id: true, fullName: true, email: true } } }, orderBy: { createdAt: 'desc' }, take: 500 }));
    } catch (error) { next(error); }
  });
  router.get('/admin/marketplace', async (_req, res, next) => {
    try {
      const [purchases, subscriptionListings, memberships] = await Promise.all([
        prisma.purchaseRequest.findMany({ include: { listing: { select: { id: true, title: true } }, buyer: { select: { id: true, fullName: true, email: true } }, seller: { select: { id: true, fullName: true, email: true } }, transactions: { select: { id: true, amount: true, status: true, createdAt: true } } }, orderBy: { createdAt: 'desc' }, take: 500 }),
        prisma.subscriptionListing.findMany({ include: { category: true, owner: { select: { id: true, fullName: true, email: true } }, _count: { select: { memberships: true } } }, orderBy: { createdAt: 'desc' }, take: 500 }),
        prisma.subscriptionMembership.findMany({ include: { listing: { select: { id: true, name: true, owner: { select: { id: true, fullName: true } } } }, user: { select: { id: true, fullName: true, email: true } }, transactions: { select: { id: true, amount: true, status: true } } }, orderBy: { createdAt: 'desc' }, take: 500 }),
      ]);
      res.json({ purchases, subscriptionListings, memberships });
    } catch (error) { next(error); }
  });
  router.get('/admin/transactions', async (_req, res, next) => {
    try {
      const [transactions, refunds] = await Promise.all([
        prisma.transaction.findMany({ include: { user: { select: { id: true, fullName: true, email: true } }, purchaseRequest: { select: { id: true, listing: { select: { title: true } } } }, membership: { select: { id: true, listing: { select: { name: true } } } }, booking: { select: { id: true, listing: { select: { title: true } } } }, refunds: true }, orderBy: { createdAt: 'desc' }, take: 500 }),
        prisma.refund.findMany({ include: { requestedBy: { select: { id: true, fullName: true, email: true } }, approvedBy: { select: { fullName: true } }, rejectedBy: { select: { fullName: true } }, processedBy: { select: { fullName: true } }, transaction: { select: { id: true, amount: true, currency: true, status: true, userId: true } } }, orderBy: { requestedAt: 'desc' }, take: 500 }),
      ]);
      res.json({ simulated: true, transactions, refunds });
    } catch (error) { next(error); }
  });
  router.get('/admin/reports', async (req, res, next) => {
    try {
      const status = req.query.status ? z.enum(['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED']).parse(String(req.query.status)) : undefined;
      res.json(await prisma.marketplaceReport.findMany({ where: status ? { status } : {}, include: reportInclude, orderBy: { createdAt: 'desc' }, take: 500 }));
    } catch (error) { next(error); }
  });
  router.patch('/admin/reports/:id', async (req, res, next) => {
    try {
      const { status, adminResponse } = z.object({ status: z.enum(['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED']), adminResponse: z.string().trim().max(2000).optional().default('') }).parse(req.body);
      const old = await prisma.marketplaceReport.findUnique({ where: { id: req.params.id } });
      if (!old) return res.status(404).json({ error: 'Report not found.' });
      const result = await prisma.$transaction(async (tx) => {
        const report = await tx.marketplaceReport.update({ where: { id: old.id }, data: { status, adminResponse: adminResponse || null, reviewedById: req.user.id, reviewedAt: new Date() }, include: reportInclude });
        await tx.notification.create({ data: { recipientId: old.reporterId, title: 'Report updated', message: `Your report is now ${status.toLowerCase().replace('_', ' ')}.${adminResponse ? ` ${adminResponse}` : ''}` } });
        await writeAudit(tx, req.user.id, { actionType: 'REPORT_UPDATED', entityType: 'MarketplaceReport', entityId: old.id, description: `Updated report to ${status}.`, beforeStatus: old.status, afterStatus: status });
        return report;
      });
      res.json(result);
    } catch (error) { next(error); }
  });
  router.get('/admin/audit', async (req, res, next) => {
    try {
      const filter = z.object({ actionType: z.string().max(80).optional(), entityType: z.string().max(80).optional(), adminId: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
      const rows = await prisma.auditLog.findMany({ where: { ...(filter.actionType ? { actionType: filter.actionType } : {}), ...(filter.entityType ? { entityType: filter.entityType } : {}), ...(filter.adminId ? { administratorId: filter.adminId } : {}) }, include: { administrator: { select: { id: true, fullName: true, email: true } } }, orderBy: { createdAt: 'desc' }, take: filter.limit });
      res.json(rows);
    } catch (error) { next(error); }
  });
  router.get('/admin/analytics', async (req, res, next) => {
    try {
      const range = z.enum(['7d', '30d', '90d', 'all']).default('30d').parse(String(req.query.range || '30d'));
      const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
      const from = range === 'all' ? new Date(0) : new Date(Date.now() - days * 86400000);
      const rangeWhere = (field = 'createdAt') => range === 'all' ? {} : { [field]: { gte: from } };
      const listingWhere = { ...rangeWhere(), ...(req.query.category ? { categoryId: String(req.query.category) } : {}), ...(req.query.type ? { type: z.enum(['RENT', 'SELL']).parse(String(req.query.type)) } : {}), category: { slug: { not: 'subscriptions' } } };
      const [totalUsers, activeUsers, externalUsers, totalListings, activeListings, rentListings, lendListings, sellListings, subscriptionListings, bookingRequests, approvedBookings, activeRentals, completedRentals, purchaseRequests, completedPurchases, activeMemberships, transactions, refunds, listingsByCategory, listingsByType, transactionStatus, processedRefunds, popularCategories, series] = await Promise.all([
        prisma.user.count(), prisma.user.count({ where: { isApproved: true, suspended: false } }), prisma.user.count({ where: { NOT: { email: { endsWith: '@iiita.ac.in' } } } }),
        prisma.listing.count({ where: listingWhere }), prisma.listing.count({ where: { ...listingWhere, status: 'ACTIVE' } }),
        prisma.listing.count({ where: { ...listingWhere, type: 'RENT' } }), prisma.listing.count({ where: { ...listingWhere, type: 'RENT' } }), prisma.listing.count({ where: { ...listingWhere, type: 'SELL' } }),
        prisma.subscriptionListing.count({ where: rangeWhere() }),
        countOverRange(prisma, 'booking', rangeWhere()), prisma.booking.count({ where: { ...rangeWhere(), status: 'APPROVED' } }), prisma.booking.count({ where: { ...rangeWhere(), status: 'ACTIVE' } }), prisma.booking.count({ where: { ...rangeWhere(), status: 'COMPLETED' } }),
        countOverRange(prisma, 'purchaseRequest', rangeWhere()), prisma.purchaseRequest.count({ where: { ...rangeWhere(), status: 'COMPLETED' } }), prisma.subscriptionMembership.count({ where: { ...rangeWhere(), status: 'ACTIVE' } }),
        prisma.transaction.count({ where: rangeWhere() }), prisma.refund.count({ where: rangeWhere('requestedAt') }),
        prisma.listing.groupBy({ by: ['categoryId'], where: listingWhere, _count: { _all: true } }), prisma.listing.groupBy({ by: ['type'], where: listingWhere, _count: { _all: true } }),
        prisma.transaction.groupBy({ by: ['status'], where: rangeWhere(), _count: { _all: true }, _sum: { amount: true } }), prisma.refund.aggregate({ where: { ...rangeWhere('processedAt'), status: 'PROCESSED' }, _count: { _all: true }, _sum: { amount: true } }),
        prisma.listing.groupBy({ by: ['categoryId'], where: { ...listingWhere, status: 'ACTIVE' }, _count: { _all: true }, orderBy: { _count: { categoryId: 'desc' } }, take: 5 }),
        Promise.all([
          prisma.$queryRaw`SELECT DATE("createdAt") AS "date", COUNT(*) AS "count" FROM "User" WHERE "createdAt" >= ${from} GROUP BY DATE("createdAt") ORDER BY DATE("createdAt")`,
          prisma.$queryRaw`SELECT DATE("createdAt") AS "date", COUNT(*) AS "count" FROM "Listing" WHERE "createdAt" >= ${from} GROUP BY DATE("createdAt") ORDER BY DATE("createdAt")`,
          prisma.$queryRaw`SELECT DATE("createdAt") AS "date", COUNT(*) AS "count" FROM "Booking" WHERE "createdAt" >= ${from} GROUP BY DATE("createdAt") ORDER BY DATE("createdAt")`,
          prisma.$queryRaw`SELECT DATE("createdAt") AS "date", COUNT(*) AS "count" FROM "PurchaseRequest" WHERE "createdAt" >= ${from} GROUP BY DATE("createdAt") ORDER BY DATE("createdAt")`,
          prisma.$queryRaw`SELECT DATE("createdAt") AS "date", COUNT(*) AS "count" FROM "SubscriptionMembership" WHERE "createdAt" >= ${from} GROUP BY DATE("createdAt") ORDER BY DATE("createdAt")`,
          prisma.$queryRaw`SELECT DATE("createdAt") AS "date", SUM("amount") AS "amount" FROM "Transaction" WHERE "createdAt" >= ${from} GROUP BY DATE("createdAt") ORDER BY DATE("createdAt")`,
        ]),
      ]);
      const categories = await prisma.category.findMany({ where: { id: { in: [...new Set([...listingsByCategory, ...popularCategories].map((x) => x.categoryId))] } }, select: { id: true, name: true } });
      const categoryNames = Object.fromEntries(categories.map((item) => [item.id, item.name]));
      const [registrations, listingActivity, bookingActivity, purchaseActivity, subscriptionActivity, transactionVolume] = series;
      const numberRows = (rows, field = 'count') => rows.map((row) => ({ ...row, [field]: Number(row[field] || 0) }));
      res.json({ range, definition: { activeUsers: 'Approved, non-suspended accounts (not a measure of recent sessions); Lend is included in the current RENT listing type because there is no distinct persisted LEND type.' }, overview: { totalUsers, activeUsers, externalUsers, totalListings, activeListings, rentListings, lendListings, sellListings, subscriptionListings, bookingRequests, approvedBookings, activeRentals, completedRentals, purchaseRequests, completedPurchases, activeMemberships, transactions, refundRequests: refunds }, marketplace: { listingsByCategory: listingsByCategory.map((x) => ({ name: categoryNames[x.categoryId] || 'Unknown', count: x._count._all })), listingsByType: listingsByType.map((x) => ({ type: x.type, count: x._count._all })), popularCategories: popularCategories.map((x) => ({ name: categoryNames[x.categoryId] || 'Unknown', count: x._count._all })), activeListings, inactiveListings: totalListings - activeListings, registrations: numberRows(registrations), listingActivity: numberRows(listingActivity), bookingActivity: numberRows(bookingActivity), purchaseActivity: numberRows(purchaseActivity), subscriptionActivity: numberRows(subscriptionActivity) }, transactions: { status: transactionStatus.map((x) => ({ status: x.status, count: x._count._all, amount: x._sum.amount || 0 })), processedRefunds: processedRefunds._count._all, refundAmountRecorded: processedRefunds._sum.amount || 0, simulatedVolumeOverTime: numberRows(transactionVolume, 'amount') } });
    } catch (error) { next(error); }
  });
  return router;
}
