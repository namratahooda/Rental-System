import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from './auth.js';
import { calculateDailyAvailability, calculateRentalAmount, dateKey, parseDateOnly, validateDateRange } from './booking-domain.js';

const router = Router();
let db;
router.use((req, _res, next) => { req.prisma = db; next(); });
const person = { select: { id: true, fullName: true, profilePhoto: true } };
const requestInclude = { category: true, requester: person, _count: { select: { offers: true } } };
const offerInclude = { offerer: person, listing: { include: { category: true, images: { take: 1 } } }, subscriptionListing: { include: { category: true, owner: person } } };
const fail = (status, message) => Object.assign(new Error(message), { statusCode: status });
function sendError(res, next, e) { if (e.statusCode) return res.status(e.statusCode).json({ error: e.message }); if (e.code === 'P2002') return res.status(409).json({ error: 'This offer has already been recorded.' }); if (['P2034','P2028'].includes(e.code)||/SQLITE_BUSY|database is locked/i.test(String(e.message||''))) return res.status(409).json({ error: 'This request changed while processing. Refresh and try again.' }); return next(e); }
function expiryDefault() { const n = Number(process.env.LOOKING_FOR_EXPIRY_DAYS); const days = Number.isInteger(n) && n >= 7 && n <= 90 ? n : 30; return new Date(Date.now() + days * 86400000); }
const blankToUndefined = schema => z.preprocess(value => value == null || typeof value === 'string' && value.trim() === '' ? undefined : value, schema.optional());
const requestSchema = z.object({
  title: z.string({ required_error: 'Please enter a request title.' }).trim().min(3, 'Please enter a request title (at least 3 characters).').max(120, 'Request title must be 120 characters or fewer.'),
  description: z.string({ required_error: 'Please enter a description.' }).trim().min(10, 'Please enter at least 10 characters in the description.').max(2000, 'Description must be 2000 characters or fewer.'),
  categoryId: z.string({ required_error: 'Please select a category.' }).trim().min(1, 'Please select a category.'),
  requestType: z.enum(['RENT','BUY','SUBSCRIPTION'], { required_error: 'Please select a request type.', invalid_type_error: 'Please select a valid request type.' }),
  quantity: z.coerce.number({ invalid_type_error: 'Please enter a valid quantity.' }).int('Quantity must be a whole number.').min(1, 'Quantity must be at least 1.').max(500, 'Quantity cannot exceed 500.'),
  budgetMin: z.coerce.number({ invalid_type_error: 'Please enter a valid minimum budget.' }).int().min(0, 'Minimum budget cannot be negative.').max(2147483647),
  budgetMax: z.coerce.number({ invalid_type_error: 'Please enter a valid maximum budget.' }).int().positive('Please enter a valid maximum budget.').max(2147483647),
  startDate: blankToUndefined(z.string()), endDate: blankToUndefined(z.string()), rentalDuration: blankToUndefined(z.string().trim().max(120)),
  desiredCondition: blankToUndefined(z.enum(['NEW','LIKE_NEW','GOOD','FAIR'])), specifications: blankToUndefined(z.string().trim().max(1000)),
  subscriptionName: blankToUndefined(z.string().trim().min(2, 'Please enter a service name (at least 2 characters).').max(100)), desiredPlan: blankToUndefined(z.string().trim().min(2, 'Please enter a plan name (at least 2 characters).').max(120)),
  desiredDurationDays: z.preprocess(value => value == null || value === '' ? undefined : value, z.coerce.number().int().min(1).max(3650).optional()), seats: z.preprocess(value => value == null || value === '' ? undefined : value, z.coerce.number().int().min(1).max(500).optional()),
  expiresAt: blankToUndefined(z.string()),
}).superRefine((d, ctx) => {
  if (d.budgetMin > d.budgetMax) ctx.addIssue({ code: 'custom', path: ['budgetMax'], message: 'Minimum budget cannot exceed maximum budget.' });
  if (d.requestType === 'RENT') {
    const range = validateDateRange(d.startDate, d.endDate);
    if (range.error) {
      const field = parseDateOnly(d.startDate) && (!parseDateOnly(d.endDate) || d.endDate <= d.startDate) ? 'endDate' : 'startDate';
      ctx.addIssue({ code: 'custom', path: [field], message: 'Please select valid rental dates: ' + range.error });
    }
    if (!d.rentalDuration) ctx.addIssue({ code: 'custom', path: ['rentalDuration'], message: 'Please enter the preferred rental duration.' });
  }
  if (d.requestType === 'BUY' && !d.desiredCondition) ctx.addIssue({ code: 'custom', path: ['desiredCondition'], message: 'Desired condition is required.' });
  if (d.requestType !== 'SUBSCRIPTION' && d.quantity > 99) ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Item quantity cannot exceed 99.' });
  if (d.requestType === 'SUBSCRIPTION' && !d.subscriptionName) ctx.addIssue({ code: 'custom', path: ['subscriptionName'], message: 'Please enter a service name.' });
  if (d.requestType === 'SUBSCRIPTION' && !d.desiredPlan) ctx.addIssue({ code: 'custom', path: ['desiredPlan'], message: 'Please enter a desired plan.' });
  if (d.requestType === 'SUBSCRIPTION' && !d.desiredDurationDays) ctx.addIssue({ code: 'custom', path: ['desiredDurationDays'], message: 'Please enter the required duration.' });
  if (d.requestType === 'SUBSCRIPTION' && !d.seats) ctx.addIssue({ code: 'custom', path: ['seats'], message: 'Please enter the number of seats.' });
  if (d.requestType === 'SUBSCRIPTION' && d.seats && d.quantity !== d.seats) ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Subscription quantity must match the number of seats.' });
});
const offerSchema = z.object({
  listingId: z.string().optional(), subscriptionListingId: z.string().optional(), offeredPrice: z.coerce.number().int().positive().max(2147483647),
  availableStartDate: z.string().optional(), availableEndDate: z.string().optional(), quantity: z.coerce.number().int().min(1).max(500),
  condition: z.enum(['NEW','LIKE_NEW','GOOD','FAIR']).optional(), message: z.string().trim().max(1000).optional(), terms: z.string().trim().max(1000).optional(),
}).superRefine((d, ctx) => { if (Boolean(d.listingId) === Boolean(d.subscriptionListingId)) ctx.addIssue({ code: 'custom', message: 'Choose one existing listing to offer.' }); });

async function expireOld(client, requesterId) {
  const soon = await client.needRequest.findMany({ where: { ...(requesterId ? { requesterId } : {}), status: { in: ['OPEN','OFFERS_RECEIVED'] }, expiryNoticeSentAt: null, expiresAt: { gt: new Date(), lte: new Date(Date.now() + 86400000) } }, select: { id: true, requesterId: true, title: true } });
  for (const row of soon) {
    const changed = await client.needRequest.updateMany({ where: { id: row.id, expiryNoticeSentAt: null, status: { in: ['OPEN','OFFERS_RECEIVED'] } }, data: { expiryNoticeSentAt: new Date() } });
    if (changed.count) await client.notification.create({ data: { recipientId: row.requesterId, needRequestId: row.id, title: 'Looking For request expiring soon', message: 'Your request "' + row.title + '" expires within 24 hours.' } });
  }
  const rows = await client.needRequest.findMany({ where: { ...(requesterId ? { requesterId } : {}), status: { in: ['OPEN','OFFERS_RECEIVED'] }, expiresAt: { lte: new Date() } }, select: { id: true, requesterId: true, title: true } });
  for (const row of rows) {
    const changed = await client.needRequest.updateMany({ where: { id: row.id, status: { in: ['OPEN','OFFERS_RECEIVED'] } }, data: { status: 'EXPIRED' } });
    if (changed.count) {
      const offers = await client.needOffer.findMany({ where: { requestId: row.id, status: 'PENDING' }, select: { id: true, offererId: true } });
      await client.needOffer.updateMany({ where: { requestId: row.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
      await client.notification.create({ data: { recipientId: row.requesterId, needRequestId: row.id, title: 'Looking For request expired', message: 'Your request "' + row.title + '" has expired.' } });
      for (const offer of offers) await client.notification.create({ data: { recipientId: offer.offererId, needRequestId: row.id, needOfferId: offer.id, title: 'Looking For request expired', message: 'The request "' + row.title + '" has expired.' } });
    }
  }
}
router.get('/needs', async (req, res, next) => {
  try {
    await expireOld(req.prisma);
    const q = z.object({ type: z.enum(['RENT','BUY','SUBSCRIPTION']).optional(), category: z.string().optional(), q: z.string().trim().max(120).optional(), minBudget: z.coerce.number().min(0).optional(), maxBudget: z.coerce.number().min(0).optional(), from: z.string().optional(), to: z.string().optional(), noOffers: z.enum(['true','false']).optional(), openOnly: z.enum(['true','false']).default('true'), sort: z.enum(['newest','oldest']).default('newest'), limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    if (q.minBudget != null && q.maxBudget != null && q.minBudget > q.maxBudget) return res.status(400).json({ error: 'Minimum budget cannot exceed maximum budget.' });
    const where = { ...(q.openOnly === 'true' ? { status: { in: ['OPEN','OFFERS_RECEIVED'] }, expiresAt: { gt: new Date() } } : {}), ...(q.type ? { requestType: q.type } : {}), ...(q.category ? { category: { slug: q.category } } : {}), ...(q.q ? { OR: [{ title: { contains: q.q } }, { description: { contains: q.q } }] } : {}), ...(q.minBudget != null || q.maxBudget != null ? { AND: [...(q.maxBudget != null ? [{ budgetMin: { lte: q.maxBudget } }] : []), ...(q.minBudget != null ? [{ budgetMax: { gte: q.minBudget } }] : [])] } : {}) };
    if (q.noOffers === 'true') where.offers = { none: {} };
    if (q.from || q.to) { const from = q.from ? parseDateOnly(q.from) : null, to = q.to ? parseDateOnly(q.to) : null; if (q.from && !from || q.to && !to) return res.status(400).json({ error: 'Choose valid availability dates.' }); where.AND = [...(where.AND || []), ...(from ? [{ endDate: { gte: from } }] : []), ...(to ? [{ startDate: { lte: to } }] : [])]; }
    const [items,total] = await Promise.all([req.prisma.needRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: q.sort === 'oldest' ? 'asc' : 'desc' }, take: q.limit, skip: q.offset }), req.prisma.needRequest.count({ where })]);
    res.json({ items, page: { limit: q.limit, offset: q.offset, total, hasMore: q.offset + items.length < total } });
  } catch (e) { sendError(res,next,e); }
});
router.get('/needs/mine', requireAuth, async (req,res,next) => {
  try {
    await expireOld(req.prisma,req.user.id);
    const [requests,offers] = await Promise.all([
      req.prisma.needRequest.findMany({ where:{requesterId:req.user.id},include:{...requestInclude,offers:{include:offerInclude,orderBy:{createdAt:'desc'}}},orderBy:{createdAt:'desc'},take:100 }),
      req.prisma.needOffer.findMany({ where:{offererId:req.user.id},include:{request:{include:requestInclude},...offerInclude},orderBy:{createdAt:'desc'},take:100 }),
    ]);
    res.json({requests,offers});
  } catch(e){next(e);}
});
router.get('/needs/:id', async (req,res,next) => {
  try {
    const item=await req.prisma.needRequest.findUnique({where:{id:req.params.id},include:requestInclude});
    if(!item||(['EXPIRED','CANCELLED'].includes(item.status)&&req.user?.id!==item.requesterId))return res.status(404).json({error:'Looking For request not found.'});
    if(req.user?.id===item.requesterId)return res.json({...item,offers:await req.prisma.needOffer.findMany({where:{requestId:item.id},include:offerInclude,orderBy:{createdAt:'desc'}})});
    const myOffers=req.user?await req.prisma.needOffer.findMany({where:{requestId:item.id,offererId:req.user.id},include:offerInclude}):[];
    res.json({...item,myOffers});
  }catch(e){next(e);}
});
router.post('/needs',requireAuth,async(req,res,next)=>{
  try{
    const d=requestSchema.parse(req.body),now=new Date(),expiresAt=d.expiresAt?new Date(d.expiresAt):expiryDefault();
    if(!Number.isFinite(expiresAt.getTime())||expiresAt<=now||expiresAt>new Date(now.getTime()+90*86400000))return res.status(400).json({error:'Expiry must be within 90 days.'});
    if(!await req.prisma.category.findFirst({where:{id:d.categoryId,active:true}}))return res.status(400).json({error:'Choose an active category.'});
    if(await req.prisma.needRequest.count({where:{requesterId:req.user.id,createdAt:{gte:new Date(now.getTime()-86400000)}}})>=5)return res.status(429).json({error:'Limit reached: five requests per day.'});
    const created=await req.prisma.needRequest.create({data:{requesterId:req.user.id,categoryId:d.categoryId,title:d.title,description:d.description,requestType:d.requestType,quantity:d.quantity,budgetMin:d.budgetMin,budgetMax:d.budgetMax,...(d.requestType==='RENT'?{startDate:parseDateOnly(d.startDate),endDate:parseDateOnly(d.endDate),rentalDuration:d.rentalDuration,desiredCondition:d.desiredCondition}:{}),...(d.requestType==='BUY'?{desiredCondition:d.desiredCondition}:{}),...(d.specifications?{specifications:d.specifications}:{}),...(d.requestType==='SUBSCRIPTION'?{subscriptionName:d.subscriptionName,desiredPlan:d.desiredPlan,desiredDurationDays:d.desiredDurationDays,seats:d.seats}:{}),expiresAt},include:requestInclude});
    res.status(201).json(created);
  }catch(e){sendError(res,next,e);}
});
router.patch('/needs/:id',requireAuth,async(req,res,next)=>{
  try{
    const d=z.object({title:z.string().trim().min(3).max(120).optional(),description:z.string().trim().min(10).max(2000).optional(),budgetMin:z.coerce.number().int().min(0).max(2147483647).optional(),budgetMax:z.coerce.number().int().positive().max(2147483647).optional(),specifications:z.string().trim().max(1000).optional(),expiresAt:z.string().optional()}).strict().parse(req.body);
    const current=await req.prisma.needRequest.findUnique({where:{id:req.params.id}});
    if(!current||current.requesterId!==req.user.id)return res.status(404).json({error:'Looking For request not found.'});
    if(!['OPEN','OFFERS_RECEIVED'].includes(current.status))return res.status(409).json({error:'Only open requests may be edited.'});
    if(await req.prisma.needOffer.count({where:{requestId:current.id}}))return res.status(409).json({error:'A request with offer history can no longer be edited. You may withdraw it and post an updated request.'});
    const min=d.budgetMin??current.budgetMin,max=d.budgetMax??current.budgetMax;
    if(min>max)return res.status(400).json({error:'Minimum budget cannot exceed maximum budget.'});
    let expiresAt;
    if(d.expiresAt){expiresAt=new Date(d.expiresAt);if(!Number.isFinite(expiresAt.getTime())||expiresAt<=new Date()||expiresAt>new Date(Date.now()+90*86400000))return res.status(400).json({error:'Expiry must be within 90 days.'});}
    res.json(await req.prisma.needRequest.update({where:{id:current.id},data:{...d,budgetMin:min,budgetMax:max,...(expiresAt?{expiresAt}:{})},include:requestInclude}));
  }catch(e){sendError(res,next,e);}
});
router.post('/needs/:id/cancel',requireAuth,async(req,res,next)=>{
  try{
    const result=await req.prisma.$transaction(async tx=>{
      const r=await tx.needRequest.findUnique({where:{id:req.params.id}});
      if(!r||r.requesterId!==req.user.id)throw fail(404,'Looking For request not found.');
      if(!['OPEN','OFFERS_RECEIVED'].includes(r.status))throw fail(409,'This request can no longer be cancelled.');
      const changed=await tx.needRequest.updateMany({where:{id:r.id,status:r.status},data:{status:'CANCELLED'}});
      if(!changed.count)throw fail(409,'Request already changed.');
      const offers=await tx.needOffer.findMany({where:{requestId:r.id,status:'PENDING'},select:{id:true,offererId:true}});
      await tx.needOffer.updateMany({where:{requestId:r.id,status:'PENDING'},data:{status:'EXPIRED'}});
      for(const o of offers)await tx.notification.create({data:{recipientId:o.offererId,needRequestId:r.id,needOfferId:o.id,title:'Looking For request cancelled',message:'The requester cancelled "'+r.title+'".'}});
      return tx.needRequest.findUnique({where:{id:r.id},include:requestInclude});
    });
    res.json(result);
  }catch(e){sendError(res,next,e);}
});
router.post('/needs/:id/offers',requireAuth,async(req,res,next)=>{
  try{
    const d=offerSchema.parse(req.body);
    await expireOld(req.prisma);
    const result=await req.prisma.$transaction(async tx=>{
      const r=await tx.needRequest.findUnique({where:{id:req.params.id}});
      if(!r)throw fail(404,'Looking For request not found.');
      if(r.requesterId===req.user.id)throw fail(400,'You cannot offer on your own request.');
      if(!['OPEN','OFFERS_RECEIVED'].includes(r.status)||r.expiresAt<=new Date())throw fail(409,'This request is no longer accepting offers.');
      if(d.offeredPrice<r.budgetMin||d.offeredPrice>r.budgetMax)throw fail(400,'Offer price must be within the requested budget.');
      if(d.quantity<r.quantity)throw fail(400,'Offer quantity is below the requested quantity.');
      let listing=null,plan=null;
      if(r.requestType==='SUBSCRIPTION'){
        plan=await tx.subscriptionListing.findUnique({where:{id:d.subscriptionListingId},include:{category:true}});
        if(!plan||plan.ownerId!==req.user.id||plan.status!=='ACTIVE'||plan.expiryDate<=new Date())throw fail(404,'Choose an active subscription listing you own.');
        if(plan.availableSeats<r.seats||plan.durationDays<r.desiredDurationDays||plan.pricePerSeat*r.seats>r.budgetMax||r.subscriptionName&&!plan.name.toLowerCase().includes(r.subscriptionName.toLowerCase()))throw fail(400,'Subscription listing does not meet the requested plan, duration, seats or budget.');
      }else{
        listing=await tx.listing.findUnique({where:{id:d.listingId}});
        const kind=r.requestType==='RENT'?'RENT':'SELL';
        if(!listing||listing.ownerId!==req.user.id||listing.type!==kind||listing.status!=='ACTIVE')throw fail(404,'Choose an active listing of the requested type that you own.');
        if(listing.ownerId===r.requesterId||listing.categoryId!==r.categoryId||listing.quantity<d.quantity)throw fail(400,'Listing owner, category or available quantity does not match the request.');
        if(r.requestType==='BUY'&&r.desiredCondition){const grade={NEW:4,LIKE_NEW:3,GOOD:2,FAIR:1};if(grade[listing.condition]<grade[r.desiredCondition])throw fail(400,'Listing condition is below the requested condition.');}
        if(r.requestType==='RENT'){
          const start=parseDateOnly(d.availableStartDate),end=parseDateOnly(d.availableEndDate);
          if(!start||!end||start>r.startDate||end<r.endDate)throw fail(400,'Offer dates must cover the requested rental period.');
          const reserved=await tx.booking.findMany({where:{listingId:listing.id,status:{in:['APPROVED','ACTIVE']},startDate:{lt:r.endDate},endDate:{gt:r.startDate}},select:{startDate:true,endDate:true,quantity:true}});
          const days=calculateDailyAvailability({inventory:listing.quantity,bookings:reserved,from:dateKey(r.startDate),to:dateKey(r.endDate)});
          if(days.some(day=>day.remaining<r.quantity))throw fail(409,'Listing is not available for the requested dates and quantity.');
        }
      }
      const offer=await tx.needOffer.create({data:{requestId:r.id,offererId:req.user.id,listingId:listing?.id||null,subscriptionListingId:plan?.id||null,offeredPrice:d.offeredPrice,quantity:d.quantity,availableStartDate:d.availableStartDate?parseDateOnly(d.availableStartDate):null,availableEndDate:d.availableEndDate?parseDateOnly(d.availableEndDate):null,condition:d.condition,message:d.message||null,terms:d.terms||null},include:offerInclude});
      await tx.needRequest.update({where:{id:r.id},data:{status:'OFFERS_RECEIVED'}});
      await tx.notification.create({data:{recipientId:r.requesterId,needRequestId:r.id,needOfferId:offer.id,title:'New Looking For offer',message:req.user.fullName+' sent an offer for "'+r.title+'" at ₹'+d.offeredPrice+'.'}});
      return offer;
    });
    res.status(201).json(result);
  }catch(e){sendError(res,next,e);}
});
router.post('/needs/:id/offers/:offerId/reject',requireAuth,async(req,res,next)=>{
  try{
    const result=await req.prisma.$transaction(async tx=>{
      const o=await tx.needOffer.findUnique({where:{id:req.params.offerId},include:{request:true}});
      if(!o||o.requestId!==req.params.id||o.request.requesterId!==req.user.id)throw fail(404,'Offer not found.');
      if(!(await tx.needOffer.updateMany({where:{id:o.id,status:'PENDING'},data:{status:'REJECTED'}})).count)throw fail(409,'Only pending offers can be rejected.');
      await tx.notification.create({data:{recipientId:o.offererId,needRequestId:o.requestId,needOfferId:o.id,title:'Looking For offer rejected',message:'Your offer for "'+o.request.title+'" was not selected.'}});
      return tx.needOffer.findUnique({where:{id:o.id},include:offerInclude});
    });
    res.json(result);
  }catch(e){sendError(res,next,e);}
});
router.post('/needs/:id/offers/:offerId/withdraw',requireAuth,async(req,res,next)=>{
  try{
    const o=await req.prisma.needOffer.findUnique({where:{id:req.params.offerId},include:{request:true}});
    if(!o||o.requestId!==req.params.id||o.offererId!==req.user.id)return res.status(404).json({error:'Offer not found.'});
    if(!(await req.prisma.needOffer.updateMany({where:{id:o.id,status:'PENDING'},data:{status:'WITHDRAWN'}})).count)return res.status(409).json({error:'Only pending offers can be withdrawn.'});
    await req.prisma.notification.create({data:{recipientId:o.request.requesterId,needRequestId:o.requestId,needOfferId:o.id,title:'Looking For offer withdrawn',message:req.user.fullName+' withdrew an offer for "'+o.request.title+'".'}});
    res.json(await req.prisma.needOffer.findUnique({where:{id:o.id},include:offerInclude}));
  }catch(e){sendError(res,next,e);}
});
router.post('/needs/:id/offers/:offerId/accept',requireAuth,async(req,res,next)=>{
  try{
    await expireOld(req.prisma);
    const result=await req.prisma.$transaction(async tx=>{
      const o=await tx.needOffer.findUnique({where:{id:req.params.offerId},include:{request:true,listing:true,subscriptionListing:true}});
      if(!o||o.requestId!==req.params.id||o.request.requesterId!==req.user.id)throw fail(404,'Offer not found.');
      const r=o.request;
      if(!['OPEN','OFFERS_RECEIVED'].includes(r.status)||r.expiresAt<=new Date()||o.status!=='PENDING')throw fail(409,'This offer can no longer be accepted.');
      let booking=null,purchaseRequest=null,membership=null;
      if(r.requestType==='RENT'){
        const l=o.listing;if(!l||l.ownerId!==o.offererId||l.status!=='ACTIVE')throw fail(409,'Offered rental is no longer available.');
        const range=validateDateRange(dateKey(r.startDate),dateKey(r.endDate));if(range.error)throw fail(400,range.error);
        const priceUnit=l.dailyPrice!=null?'DAILY':'MONTHLY',pricing=calculateRentalAmount({...range,quantity:r.quantity,priceUnit,dailyPrice:l.dailyPrice,monthlyPrice:l.monthlyPrice});
        const reserved=await tx.booking.findMany({where:{listingId:l.id,status:{in:['APPROVED','ACTIVE']},startDate:{lt:range.endDate},endDate:{gt:range.startDate}},select:{startDate:true,endDate:true,quantity:true}});
        if(calculateDailyAvailability({inventory:l.quantity,bookings:reserved,from:dateKey(range.startDate),to:dateKey(range.endDate)}).some(d=>d.remaining<r.quantity))throw fail(409,'Rental availability changed.');
        booking=await tx.booking.create({data:{listingId:l.id,renterId:r.requesterId,ownerId:l.ownerId,startDate:range.startDate,endDate:range.endDate,quantity:r.quantity,priceUnit,rentalUnits:pricing.rentalUnits,originalAmount:pricing.amount,agreedAmount:o.offeredPrice,renterMessage:'Accepted Looking For offer '+o.id,idempotencyKey:crypto.randomBytes(24).toString('base64url')}});
        await tx.needOffer.update({where:{id:o.id},data:{bookingId:booking.id}});
        await tx.notification.create({data:{recipientId:l.ownerId,bookingId:booking.id,needRequestId:r.id,needOfferId:o.id,title:'New rental request from Looking For',message:req.user.fullName+' accepted your offer. Review the booking request.'}});
      }else if(r.requestType==='BUY'){
        const l=o.listing;if(!l||l.ownerId!==o.offererId||l.status!=='ACTIVE'||l.quantity<r.quantity)throw fail(409,'Offered sale listing is no longer available.');
        purchaseRequest=await tx.purchaseRequest.create({data:{listingId:l.id,buyerId:r.requesterId,sellerId:l.ownerId,quantity:r.quantity,originalAmount:Math.round((l.salePrice||0)*r.quantity),agreedAmount:o.offeredPrice,message:'Accepted Looking For offer '+o.id,idempotencyKey:crypto.randomBytes(24).toString('base64url')}});
        await tx.needOffer.update({where:{id:o.id},data:{purchaseRequestId:purchaseRequest.id}});
        await tx.notification.create({data:{recipientId:l.ownerId,purchaseRequestId:purchaseRequest.id,needRequestId:r.id,needOfferId:o.id,title:'New purchase request from Looking For',message:req.user.fullName+' accepted your offer. Review the purchase request.'}});
      }else{
        const p=o.subscriptionListing;if(!p||p.ownerId!==o.offererId||p.status!=='ACTIVE'||p.expiryDate<=new Date()||p.availableSeats<r.seats||p.durationDays<r.desiredDurationDays)throw fail(409,'Subscription availability changed.');
        membership=await tx.subscriptionMembership.create({data:{listingId:p.id,userId:r.requesterId,seatCount:r.seats,amount:o.offeredPrice,startDate:p.startDate>new Date()?p.startDate:new Date(),expiryDate:p.expiryDate,status:'PENDING',message:'Accepted Looking For offer '+o.id}});
        await tx.needOffer.update({where:{id:o.id},data:{membershipId:membership.id}});
        await tx.notification.create({data:{recipientId:p.ownerId,membershipId:membership.id,needRequestId:r.id,needOfferId:o.id,title:'New subscription request from Looking For',message:req.user.fullName+' accepted your offer. Review the seat request.'}});
      }
      const changed=await tx.needRequest.updateMany({where:{id:r.id,status:{in:['OPEN','OFFERS_RECEIVED']}},data:{status:'OFFER_ACCEPTED'}});
      if(!changed.count)throw fail(409,'Another offer was already accepted.');
      await tx.needOffer.update({where:{id:o.id},data:{status:'ACCEPTED'}});
      const others=await tx.needOffer.findMany({where:{requestId:r.id,id:{not:o.id},status:'PENDING'},select:{id:true,offererId:true}});
      await tx.needOffer.updateMany({where:{requestId:r.id,id:{not:o.id},status:'PENDING'},data:{status:'REJECTED',terms:'Another offer was accepted.'}});
      for(const other of others)await tx.notification.create({data:{recipientId:other.offererId,needRequestId:r.id,needOfferId:other.id,title:'Looking For offer not selected',message:'Another offer was accepted for "'+r.title+'".'}});
      await tx.notification.create({data:{recipientId:o.offererId,needRequestId:r.id,needOfferId:o.id,title:'Looking For offer accepted',message:'Your offer for "'+r.title+'" was accepted. Continue in the existing '+r.requestType.toLowerCase()+' workflow.'}});
      await tx.notification.create({data:{recipientId:r.requesterId,needRequestId:r.id,needOfferId:o.id,title:'Looking For offer accepted',message:'You accepted an offer for "'+r.title+'". Continue in the existing Rentol workflow.'}});
      return {request:await tx.needRequest.findUnique({where:{id:r.id},include:requestInclude}),offer:await tx.needOffer.findUnique({where:{id:o.id},include:offerInclude}),booking,purchaseRequest,membership};
    });
    res.json(result);
  }catch(e){sendError(res,next,e);}
});
export function createNeedRouter(prisma){db=prisma;return router;}
export async function fulfillNeedOffer(tx,offerId){
  if(!offerId)return;
  const o=await tx.needOffer.findUnique({where:{id:offerId},select:{requestId:true,offererId:true,request:{select:{requesterId:true,title:true}}}});
  if(!o)return;
  const changed=await tx.needRequest.updateMany({where:{id:o.requestId,status:'OFFER_ACCEPTED'},data:{status:'FULFILLED',fulfilledAt:new Date()}});
  if(changed.count){await tx.notification.create({data:{recipientId:o.request.requesterId,needRequestId:o.requestId,needOfferId:offerId,title:'Looking For request fulfilled',message:'Your request "'+o.request.title+'" has been fulfilled.'}});await tx.notification.create({data:{recipientId:o.offererId,needRequestId:o.requestId,needOfferId:offerId,title:'Looking For request fulfilled',message:'The request "'+o.request.title+'" was fulfilled through your offer.'}});}
}
