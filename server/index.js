import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { prisma } from './db.js';
import { isInstitutionalEmail, normalizeEmail } from './email-policy.js';
import { clearSession, createSession, optionalAuth, publicUser, requireAdmin, requireAuth } from './auth.js';
import { createBookingRouter } from './booking-routes.js';
import { createMarketplaceRouter } from './marketplace-routes.js';
import { maxReservedQuantity } from './booking-domain.js';

const app = express();
const port = Number(process.env.PORT || 4000);
const pendingGoogleExternalRequests = new Map();
app.use(express.json({ limit: '8mb' })); app.use(cookieParser()); app.use(optionalAuth);
app.use('/api', createMarketplaceRouter(prisma));
app.use('/api', createBookingRouter(prisma));
const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 864e5 };
const googleCookieOptions = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 10 * 60 * 1000, path: '/' };
const frontendUrl = (path) => `${(process.env.CLIENT_ORIGIN || 'http://localhost:5173').replace(/\/$/, '')}${path}`;
const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const googleOAuthClient = () => new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALLBACK_URL || `http://localhost:${port}/api/auth/google/callback`
);
const userSchema = z.object({ fullName: z.string().trim().min(2).max(80), email: z.string().trim().email().transform(normalizeEmail), password: z.string().min(8).max(100), college: z.string().trim().max(120).optional(), department: z.string().max(80).optional(), yearOfStudy: z.string().max(30).optional(), contactInfo: z.string().max(80).optional(), reason: z.string().max(500).optional() });
const listingSchema = z.object({ type: z.enum(['RENT','SELL']), title: z.string().trim().min(2).max(100), categoryId: z.string().min(1), description: z.string().trim().min(5).max(3000), quantity: z.coerce.number().int().min(1).max(99).default(1), condition: z.enum(['NEW','LIKE_NEW','GOOD','FAIR']), dailyPrice: z.coerce.number().nonnegative().optional().nullable(), monthlyPrice: z.coerce.number().nonnegative().optional().nullable(), deposit: z.coerce.number().nonnegative().optional().nullable(), salePrice: z.coerce.number().positive().optional().nullable(), pickupLocation: z.string().trim().min(2).max(120), images: z.array(z.string().max(1200000)).max(5).optional().default([]) });
const safeListing = { include: { category: true, images: true, owner: { select: { id: true, fullName: true, profilePhoto: true, college: true, department: true, yearOfStudy: true, createdAt: true } } } };
app.get('/api/health', (_req,res) => res.json({ ok: true }));
app.get('/api/categories', async (_req,res,next) => { try { res.json(await prisma.category.findMany({ where:{slug:{not:'subscriptions'}}, orderBy: { name: 'asc' } })); } catch(e){ next(e); } });
app.post('/api/auth/register', async (req,res,next) => {
  try {
    const data = userSchema.parse(req.body);
    const isInstitutional = isInstitutionalEmail(data.email);
    if (!isInstitutional && !data.college) return res.status(400).json({error:'Enter your college affiliation for the access request.'});
    if (!isInstitutional && !data.reason?.trim()) return res.status(400).json({error:'Tell the campus team why you need access.'});
    if (await prisma.user.findUnique({ where: { email: data.email } })) return res.status(409).json({ error: 'An account with this email already exists.' });
    const user = await prisma.user.create({ data: { fullName: data.fullName, email: data.email, passwordHash: await bcrypt.hash(data.password, 12), college: data.college || 'IIIT Allahabad', department: data.department, yearOfStudy: data.yearOfStudy, contactInfo: data.contactInfo, role: 'STUDENT', isApproved: isInstitutional, ...(!isInstitutional ? { accessRequest: { create: { reason: data.reason } } } : {}) } });
    if (!user.isApproved) return res.status(202).json({ message: 'Your access request is pending administrator review.' });
    res.cookie('rentol_session', createSession(user.id), cookieOptions).status(201).json({ user: publicUser(user) });
  } catch(e){ next(e); }
});
app.post('/api/auth/login', async (req,res,next) => { try {
  const email = normalizeEmail(req.body.email); const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.passwordHash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  if (!user.isApproved) return res.status(403).json({ error: 'Your access request is awaiting administrator approval.' });
  res.cookie('rentol_session', createSession(user.id), cookieOptions).json({ user: publicUser(user) });
} catch(e){ next(e); } });
app.get('/api/auth/google', async (_req,res,next) => {
  if (!googleConfigured()) return res.redirect(frontendUrl('/login?google=unconfigured'));
  try {
    const state = crypto.randomBytes(32).toString('base64url');
    const client = googleOAuthClient();
    const {codeVerifier,codeChallenge} = await client.generateCodeVerifierAsync();
    res.cookie('rentol_google_state',state,googleCookieOptions);
    res.cookie('rentol_google_verifier',codeVerifier,googleCookieOptions);
    res.redirect(client.generateAuthUrl({
      access_type:'online',
      scope:['openid','email','profile'],
      state,
      code_challenge:codeChallenge,
      code_challenge_method:'S256',
      prompt:'select_account'
    }));
  } catch(e){ next(e); }
});
app.get('/api/auth/google/callback', async (req,res) => {
  const clearGoogleCookies = () => {
    const options = {path:'/',sameSite:'lax',secure:process.env.NODE_ENV==='production'};
    res.clearCookie('rentol_google_state',options);
    res.clearCookie('rentol_google_verifier',options);
  };
  const finish = (result) => { clearGoogleCookies(); return res.redirect(frontendUrl(`/login?google=${result}`)); };
  if (!googleConfigured()) return finish('unconfigured');
  if (req.query.error) return finish('cancelled');
  const stateCookie = req.cookies.rentol_google_state;
  const stateQuery = String(req.query.state || '');
  const verifier = req.cookies.rentol_google_verifier;
  if (!req.query.code || !stateCookie || !verifier || stateCookie.length !== stateQuery.length || !crypto.timingSafeEqual(Buffer.from(stateCookie),Buffer.from(stateQuery))) return finish('state');
  try {
    const client = googleOAuthClient();
    const {tokens} = await client.getToken({code:String(req.query.code),codeVerifier:verifier});
    if (!tokens.id_token) return finish('failed');
    const ticket = await client.verifyIdToken({idToken:tokens.id_token,audience:process.env.GOOGLE_CLIENT_ID});
    const identity = ticket.getPayload();
    if (!identity?.email || identity.email_verified !== true) return finish('unverified');
    const email = normalizeEmail(identity.email);
    if (!z.string().email().safeParse(email).success) return finish('unverified');
    const isInstitutional = isInstitutionalEmail(email);
    let user = await prisma.user.findUnique({where:{email},include:{accessRequest:true}});
    if (!user && !isInstitutional) {
      for (const [token,request] of pendingGoogleExternalRequests) if (request.expiresAt < Date.now()) pendingGoogleExternalRequests.delete(token);
      const token = crypto.randomBytes(32).toString('base64url');
      pendingGoogleExternalRequests.set(token,{email,name:identity.name || email.split('@')[0],profilePhoto:identity.picture || null,expiresAt:Date.now()+10*60*1000});
      clearGoogleCookies();
      res.cookie('rentol_google_external',token,{...googleCookieOptions,path:'/api/auth/google/external-request'});
      return res.redirect(frontendUrl('/register?google=external'));
    }
    if (!user) {
      user = await prisma.user.create({data:{
        fullName:identity.name || email.split('@')[0],
        email,
        passwordHash:await bcrypt.hash(crypto.randomBytes(48).toString('base64url'),12),
        college:'IIIT Allahabad',
        profilePhoto:identity.picture || null,
        role:'STUDENT',
        isApproved:true
      },include:{accessRequest:true}});
    } else if (!user.profilePhoto && identity.picture) {
      user = await prisma.user.update({where:{id:user.id},data:{profilePhoto:identity.picture},include:{accessRequest:true}});
    }
    if (!user.isApproved) return finish(user.accessRequest?.status==='REJECTED'?'rejected':'pending');
    clearGoogleCookies();
    res.cookie('rentol_session',createSession(user.id),cookieOptions).redirect(frontendUrl('/dashboard'));
  } catch(error) {
    console.error(error?.message || String(error));
    finish('failed');
  }
});
app.get('/api/auth/google/external-request', (req,res) => {
  const token = req.cookies.rentol_google_external;
  const request = token && pendingGoogleExternalRequests.get(token);
  if (!request || request.expiresAt < Date.now()) {
    if (token) pendingGoogleExternalRequests.delete(token);
    return res.status(401).json({error:'Google access request expired. Please continue with Google again.'});
  }
  res.json({name:request.name,email:request.email});
});
app.post('/api/auth/google/external-request', async (req,res,next) => {
  try {
    const token = req.cookies.rentol_google_external;
    const request = token && pendingGoogleExternalRequests.get(token);
    if (!request || request.expiresAt < Date.now()) {
      if (token) pendingGoogleExternalRequests.delete(token);
      res.clearCookie('rentol_google_external',{path:'/api/auth/google/external-request',sameSite:'lax',secure:process.env.NODE_ENV==='production'});
      return res.status(401).json({error:'Google access request expired. Please continue with Google again.'});
    }
    const {college,reason} = z.object({college:z.string().trim().min(2).max(120),reason:z.string().trim().min(5).max(500)}).parse(req.body);
    if (await prisma.user.findUnique({where:{email:request.email}})) return res.status(409).json({error:'An account with this Google email already exists. Please log in with Google.'});
    await prisma.user.create({data:{fullName:request.name,email:request.email,passwordHash:await bcrypt.hash(crypto.randomBytes(48).toString('base64url'),12),profilePhoto:request.profilePhoto,college,isApproved:false,accessRequest:{create:{reason}}}});
    pendingGoogleExternalRequests.delete(token);
    res.clearCookie('rentol_google_external',{path:'/api/auth/google/external-request',sameSite:'lax',secure:process.env.NODE_ENV==='production'});
    res.status(202).json({message:'Your access request is pending administrator review.'});
  } catch(error) { next(error); }
});
app.post('/api/auth/logout', (req,res) => { clearSession(req.cookies.rentol_session); res.clearCookie('rentol_session', { httpOnly: true, sameSite: 'lax' }).json({ ok: true }); });
app.get('/api/auth/me', (req,res) => res.json({ user: req.user ? publicUser(req.user) : null }));
app.patch('/api/profile', requireAuth, async (req,res,next) => { try { const data = z.object({ fullName:z.string().trim().min(2).max(80), college:z.string().trim().min(2).max(120).optional().nullable(), department:z.string().max(80).optional().nullable(), yearOfStudy:z.string().max(30).optional().nullable(), contactInfo:z.string().max(80).optional().nullable(), profilePhoto:z.string().max(500).optional().nullable() }).parse(req.body); res.json({ user: publicUser(await prisma.user.update({ where:{id:req.user.id}, data })) }); } catch(e){next(e);} });
app.get('/api/listings', async (req,res,next) => { try {
  const { q, type, category, condition, minPrice, maxPrice, sort='newest', mine, featured } = req.query;
  const restrictions = [{category:{slug:{not:'subscriptions'}}}];
  const where = { ...(mine === 'true' && req.user ? { ownerId:req.user.id } : { status:'ACTIVE' }), ...(type && ['RENT','SELL'].includes(type) ? {type} : {}), ...(category ? {category:{slug:String(category)}} : {}), ...(condition && ['NEW','LIKE_NEW','GOOD','FAIR'].includes(condition) ? {condition} : {}) };
  if(q) where.OR=[{title:{contains:String(q)}},{description:{contains:String(q)}},{category:{name:{contains:String(q)}}}];
  const priceField = type === 'RENT' ? 'dailyPrice' : 'salePrice';
  const min = minPrice === undefined ? undefined : Number(minPrice);
  const max = maxPrice === undefined ? undefined : Number(maxPrice);
  if ((min !== undefined && (!Number.isFinite(min) || min < 0)) || (max !== undefined && (!Number.isFinite(max) || max < 0))) return res.status(400).json({error:'Price filters must be non-negative numbers.'});
  const range = { ...(min !== undefined ? {gte:min} : {}), ...(max !== undefined ? {lte:max} : {}) };
  if (min !== undefined || max !== undefined) {
    if (type === 'RENT') restrictions.push({OR:[{dailyPrice:range},{monthlyPrice:range}]});
    else where[priceField] = range;
  }
  where.AND = restrictions;
  const priceSort = sort === 'price-asc' || sort === 'price-desc';
  const orderBy = featured==='true' ? [{wishlistedBy:{_count:'desc'}},{createdAt:'desc'}] : priceSort && type === 'RENT' ? {createdAt:'desc'} : sort==='price-asc'?{[priceField]:'asc'}:sort==='price-desc'?{[priceField]:'desc'}:{createdAt:'desc'};
  const listings = await prisma.listing.findMany({where,include:safeListing.include,orderBy,...(featured==='true'?{take:4}:{})});
  if (priceSort && type === 'RENT') listings.sort((a,b) => ((a.dailyPrice ?? a.monthlyPrice ?? Infinity) - (b.dailyPrice ?? b.monthlyPrice ?? Infinity)) * (sort === 'price-asc' ? 1 : -1));
  res.json(listings);
} catch(e){next(e);} });
app.get('/api/listings/:id', async (req,res,next) => { try { const item=await prisma.listing.findUnique({where:{id:req.params.id},...safeListing}); if(!item||item.status==='REMOVED'||item.category.slug==='subscriptions'||(item.status==='PAUSED'&&item.ownerId!==req.user?.id&&req.user?.role!=='ADMIN')) return res.status(404).json({error:'Listing not found.'}); res.json(item); } catch(e){next(e);} });
app.post('/api/listings', requireAuth, async (req,res,next) => { try {
  const d=listingSchema.parse(req.body); const category=await prisma.category.findFirst({where:{id:d.categoryId,slug:{not:'subscriptions'}}}); if(!category)return res.status(400).json({error:'Choose an available category.'}); if(d.type==='RENT'&&!d.dailyPrice&&!d.monthlyPrice) return res.status(400).json({error:'Add a daily or monthly rental price.'}); if(d.type==='SELL'&&!d.salePrice) return res.status(400).json({error:'Add a selling price.'});
  const {images,...fields}=d; const item=await prisma.listing.create({data:{...fields,ownerId:req.user.id,images:{create:images.map(url=>({url}))}},...safeListing}); res.status(201).json(item);
}catch(e){next(e);} });
app.patch('/api/listings/:id', requireAuth, async (req,res,next) => { try {
  const old=await prisma.listing.findUnique({where:{id:req.params.id}});
  if(!old)return res.status(404).json({error:'Listing not found.'});
  if(old.ownerId!==req.user.id&&req.user.role!=='ADMIN')return res.status(403).json({error:'You cannot edit this listing.'});
  if(old.status==='SOLD')return res.status(409).json({error:'Sold listings cannot be edited.'});
  if(old.status==='REMOVED'&&req.user.role!=='ADMIN')return res.status(404).json({error:'Listing not found.'});
  const d=listingSchema.partial().parse(req.body); const nextType=d.type||old.type; const dailyPrice=d.dailyPrice===undefined?old.dailyPrice:d.dailyPrice; const monthlyPrice=d.monthlyPrice===undefined?old.monthlyPrice:d.monthlyPrice; const salePrice=d.salePrice===undefined?old.salePrice:d.salePrice;
  if(nextType==='RENT'&&!dailyPrice&&!monthlyPrice)return res.status(400).json({error:'Add a daily or monthly rental price.'});
  if(nextType==='SELL'&&!salePrice)return res.status(400).json({error:'Add a selling price.'});
  if(d.categoryId&&!await prisma.category.findFirst({where:{id:d.categoryId,slug:{not:'subscriptions'}}}))return res.status(400).json({error:'Choose an available category.'});
  const history=await prisma.booking.count({where:{listingId:old.id}});
  if(history&&nextType!==old.type)return res.status(409).json({error:'Listing type cannot change while rental history exists.'});
  if(d.quantity!==undefined&&old.type==='RENT'){
    const reservations=await prisma.booking.findMany({where:{listingId:old.id,status:{in:['APPROVED','ACTIVE']}},select:{startDate:true,endDate:true,quantity:true,status:true}});
    if(d.quantity<maxReservedQuantity(reservations))return res.status(409).json({error:'Quantity cannot be lower than units already reserved for overlapping dates.'});
  }
  const {images,...fields}=d; const item=await prisma.listing.update({where:{id:old.id},data:{...fields,...(images ? { images: { deleteMany: {}, create: images.map(url=>({url})) } } : {})},...safeListing});res.json(item);
}catch(e){next(e);} });
app.delete('/api/listings/:id', requireAuth, async (req,res,next) => { try {
  const old=await prisma.listing.findUnique({where:{id:req.params.id}});if(!old)return res.status(404).json({error:'Listing not found.'});if(old.ownerId!==req.user.id&&req.user.role!=='ADMIN')return res.status(403).json({error:'You cannot delete this listing.'});
  if(await prisma.booking.count({where:{listingId:old.id}})||await prisma.purchaseRequest.count({where:{listingId:old.id}})){await prisma.listing.update({where:{id:old.id},data:{status:'REMOVED'}});return res.json({ok:true,archived:true});}
  await prisma.listing.delete({where:{id:old.id}});res.json({ok:true});
}catch(e){next(e);} });
app.patch('/api/listings/:id/status', requireAuth, async (req,res,next) => {try {const old=await prisma.listing.findUnique({where:{id:req.params.id}});if(!old)return res.status(404).json({error:'Listing not found.'});if(old.ownerId!==req.user.id&&req.user.role!=='ADMIN')return res.status(403).json({error:'You cannot update this listing.'});if(old.status==='SOLD')return res.status(409).json({error:'Sold listings cannot be republished.'});if(old.status==='REMOVED'&&req.user.role!=='ADMIN')return res.status(404).json({error:'Listing not found.'});const status=z.enum(['ACTIVE','PAUSED']).parse(req.body.status);res.json(await prisma.listing.update({where:{id:old.id},data:{status}}));}catch(e){next(e);} });
app.get('/api/wishlist',requireAuth,async(req,res,next)=>{try{res.json(await prisma.wishlist.findMany({where:{userId:req.user.id},include:{listing:safeListing}}));}catch(e){next(e);}});
app.post('/api/wishlist/:listingId',requireAuth,async(req,res,next)=>{try{res.json(await prisma.wishlist.upsert({where:{userId_listingId:{userId:req.user.id,listingId:req.params.listingId}},create:{userId:req.user.id,listingId:req.params.listingId},update:{}}));}catch(e){next(e);}});
app.delete('/api/wishlist/:listingId',requireAuth,async(req,res,next)=>{try{await prisma.wishlist.deleteMany({where:{userId:req.user.id,listingId:req.params.listingId}});res.json({ok:true});}catch(e){next(e);}});
app.get('/api/admin/users',requireAuth,requireAdmin,async(_req,res,next)=>{try{res.json((await prisma.user.findMany({include:{accessRequest:true},orderBy:{createdAt:'desc'}})).map(publicUser));}catch(e){next(e);}});
app.get('/api/admin/stats',requireAuth,requireAdmin,async(_req,res,next)=>{try{const [users,pendingRequests,suspendedUsers,rentListings,saleListings]=await Promise.all([prisma.user.count(),prisma.externalAccessRequest.count({where:{status:'PENDING'}}),prisma.user.count({where:{isApproved:false,OR:[{accessRequest:{is:null}},{accessRequest:{is:{status:'APPROVED'}}}]}}),prisma.listing.count({where:{type:'RENT',status:'ACTIVE',category:{slug:{not:'subscriptions'}}}}),prisma.listing.count({where:{type:'SELL',status:'ACTIVE',category:{slug:{not:'subscriptions'}}}})]);res.json({users,pendingRequests,suspendedUsers,rentListings,saleListings,activeListings:rentListings+saleListings});}catch(e){next(e);}});
app.get('/api/admin/requests',requireAuth,requireAdmin,async(_req,res,next)=>{try{res.json(await prisma.externalAccessRequest.findMany({include:{user:{select:{id:true,fullName:true,email:true,college:true,createdAt:true}}},orderBy:{createdAt:'desc'}}));}catch(e){next(e);}});
app.patch('/api/admin/requests/:id',requireAuth,requireAdmin,async(req,res,next)=>{try{const status=z.enum(['APPROVED','REJECTED']).parse(req.body.status);const r=await prisma.externalAccessRequest.update({where:{id:req.params.id},data:{status,reviewedAt:new Date(),user:{update:{isApproved:status==='APPROVED'}}},include:{user:true}});res.json({request:r,user:publicUser(r.user)});}catch(e){next(e);}});
app.get('/api/admin/listings',requireAuth,requireAdmin,async(_req,res,next)=>{try{res.json(await prisma.listing.findMany({...safeListing,orderBy:{createdAt:'desc'}}));}catch(e){next(e);}});
app.patch('/api/admin/listings/:id/remove',requireAuth,requireAdmin,async(req,res,next)=>{try{res.json(await prisma.listing.update({where:{id:req.params.id},data:{status:'REMOVED'}}));}catch(e){next(e);}});
app.patch('/api/admin/users/:id/status',requireAuth,requireAdmin,async(req,res,next)=>{try{const suspended=z.boolean().parse(req.body.suspended);if(req.params.id===req.user.id)return res.status(400).json({error:'You cannot suspend your own account.'});const target=await prisma.user.findUnique({where:{id:req.params.id},include:{accessRequest:true}});if(!target)return res.status(404).json({error:'User not found.'});if(!suspended&&target.accessRequest&&target.accessRequest.status!=='APPROVED')return res.status(409).json({error:'Pending or rejected access requests must be approved through Access requests.'});res.json(publicUser(await prisma.user.update({where:{id:req.params.id},data:{isApproved:!suspended},include:{accessRequest:true}})));}catch(e){next(e);}});
app.use((err,_req,res,_next)=>{if(err instanceof z.ZodError)return res.status(400).json({error:err.issues[0]?.message||'Please check your input.'});console.error(err?.message||String(err));if(err.code==='P2002')return res.status(409).json({error:'This record already exists.'});if(err.code==='P2025')return res.status(404).json({error:'Record not found.'});res.status(500).json({error:'Something went wrong. Please try again.'});});
export { app };
if (process.env.NODE_ENV !== 'test') app.listen(port,()=>console.log(`Rentol API listening at http://localhost:${port}`));
