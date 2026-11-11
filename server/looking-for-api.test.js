import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV='test';
const [{app},{prisma}]=await Promise.all([import('./index.js'),import('./db.js')]);
let server,base,users,category,subscriptionCategory;
const needIds=[],offerIds=[],listingIds=[],subscriptionIds=[],bookingIds=[],purchaseIds=[],membershipIds=[],transactionIds=[];
const password='Looking-for-test-password-123';
class Client{
 constructor(){this.cookies=new Map()}
 async request(path,{method='GET',body,key}={}){const headers={};if(this.cookies.size)headers.cookie=[...this.cookies].map(([k,v])=>k+'='+v).join('; ');if(body!==undefined)headers['content-type']='application/json';if(key)headers['Idempotency-Key']=key;const response=await fetch(base+'/api'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});for(const cookie of response.headers.getSetCookie()){const [pair,...attrs]=cookie.split(';'),i=pair.indexOf('='),name=pair.slice(0,i);if(attrs.some(a=>a.trim().toLowerCase()==='max-age=0'))this.cookies.delete(name);else this.cookies.set(name,pair.slice(i+1))}let data=null;try{data=await response.json()}catch{}return{status:response.status,data}}
 async login(user){const r=await this.request('/auth/login',{method:'POST',body:{email:user.email,password}});assert.equal(r.status,200);return r}
}
let clients;
const addDays=(n)=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
before(async()=>{
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
 const suffix=crypto.randomBytes(6).toString('hex'),hash=await bcrypt.hash(password,4);
 const rows=await Promise.all(['requester','offerer','other'].map(name=>prisma.user.create({data:{fullName:'Need '+name,email:'need-'+name+'-'+suffix+'@iiita.ac.in',passwordHash:hash,isApproved:true}})));
 users=Object.fromEntries(['requester','offerer','other'].map((n,i)=>[n,rows[i]]));clients=Object.fromEntries(Object.keys(users).map(n=>[n,new Client()]));
 await Promise.all(Object.keys(users).map(n=>clients[n].login(users[n])));
 category=await prisma.category.findFirst({where:{active:true,slug:{not:'subscriptions'}}});
 subscriptionCategory=await prisma.subscriptionCategory.findFirst({where:{active:true}});
});
after(async()=>{
 try{
  await prisma.notification.deleteMany({where:{OR:[{needRequestId:{in:needIds}},{needOfferId:{in:offerIds}},{bookingId:{in:bookingIds}},{purchaseRequestId:{in:purchaseIds}},{membershipId:{in:membershipIds}},{recipientId:{in:Object.values(users||{}).map(u=>u.id)}}]}});
  await prisma.needOffer.deleteMany({where:{id:{in:offerIds}}});
  await prisma.transaction.deleteMany({where:{id:{in:transactionIds}}});
  await prisma.booking.deleteMany({where:{id:{in:bookingIds}}});
  await prisma.purchaseRequest.deleteMany({where:{id:{in:purchaseIds}}});
  await prisma.subscriptionMembership.deleteMany({where:{id:{in:membershipIds}}});
  await prisma.needRequest.deleteMany({where:{id:{in:needIds}}});
  await prisma.listing.deleteMany({where:{id:{in:listingIds}}});
  await prisma.subscriptionListing.deleteMany({where:{id:{in:subscriptionIds}}});
  await prisma.user.deleteMany({where:{id:{in:Object.values(users||{}).map(u=>u.id)}}});
 }finally{await new Promise(r=>server?.close(r));await prisma.$disconnect()}
});
test('Looking For request ownership, offers and existing workflows are enforced end to end',async()=>{
 const unauth=new Client();
 const baseNeed={title:'Need a campus item',description:'Looking for something useful for my semester work.',categoryId:category.id,requestType:'RENT',quantity:1,budgetMin:50,budgetMax:1000,startDate:addDays(10),endDate:addDays(12),rentalDuration:'Two days',desiredCondition:'',specifications:'',subscriptionName:null,desiredPlan:'',expiresAt:null};
 assert.equal((await unauth.request('/needs',{method:'POST',body:baseNeed})).status,401);
 assert.equal((await clients.requester.request('/needs',{method:'POST',body:{...baseNeed,budgetMin:1200}})).status,400);
 const rent=await clients.requester.request('/needs',{method:'POST',body:baseNeed});assert.equal(rent.status,201);needIds.push(rent.data.id);
 const short=await clients.other.request('/needs',{method:'POST',body:{...baseNeed,title:'Bag',description:'Need a bag',desiredCondition:'GOOD',specifications:'Needs a carrying case'}});assert.equal(short.status,201,'short valid title and description plus optional fields are accepted');needIds.push(short.data.id);assert.equal((await clients.other.request('/needs/'+short.data.id)).data.description,'Need a bag','created request persists after a separate read');assert.equal((await prisma.needRequest.findUnique({where:{id:short.data.id}})).specifications,'Needs a carrying case');
 const missingTitle=await clients.requester.request('/needs',{method:'POST',body:{...baseNeed,title:''}});assert.equal(missingTitle.status,400);assert.equal(missingTitle.data.field,'title');assert.match(missingTitle.data.error,/request title/i);
 const invalidQuantity=await clients.requester.request('/needs',{method:'POST',body:{...baseNeed,quantity:0}});assert.equal(invalidQuantity.status,400);assert.equal(invalidQuantity.data.field,'quantity');
 const invalidDates=await clients.requester.request('/needs',{method:'POST',body:{...baseNeed,startDate:addDays(-2),endDate:addDays(-1)}});assert.equal(invalidDates.status,400);assert.ok(['startDate','endDate'].includes(invalidDates.data.field));
 assert.equal((await unauth.request('/needs')).data.items.some(x=>x.id===rent.data.id),true);
 assert.equal((await unauth.request('/needs')).data.items.find(x=>x.id===rent.data.id).requester.email,undefined);
 const rentListing=await prisma.listing.create({data:{ownerId:users.offerer.id,categoryId:category.id,type:'RENT',title:'Offer laptop',description:'A laptop for a short campus rental.',quantity:2,condition:'GOOD',dailyPrice:100,pickupLocation:'Library'}});listingIds.push(rentListing.id);
 const cancelled=await clients.requester.request('/needs',{method:'POST',body:{...baseNeed,title:'Request to cancel'}});assert.equal(cancelled.status,201);needIds.push(cancelled.data.id);
 assert.equal((await clients.requester.request('/needs/'+cancelled.data.id+'/cancel',{method:'POST'})).status,200);
 assert.equal((await clients.offerer.request('/needs/'+cancelled.data.id+'/offers',{method:'POST',body:{listingId:rentListing.id,offeredPrice:200,quantity:1,availableStartDate:addDays(10),availableEndDate:addDays(12)}})).status,409);
 const expired=await clients.requester.request('/needs',{method:'POST',body:{...baseNeed,title:'Request to expire'}});assert.equal(expired.status,201);needIds.push(expired.data.id);
 await prisma.needRequest.update({where:{id:expired.data.id},data:{expiresAt:new Date(Date.now()-86400000)}});
 const expiredOffer={listingId:rentListing.id,offeredPrice:200,quantity:1,availableStartDate:addDays(10),availableEndDate:addDays(12)};
 assert.equal((await clients.offerer.request('/needs/'+expired.data.id+'/offers',{method:'POST',body:expiredOffer})).status,409);
 assert.equal((await prisma.needRequest.findUnique({where:{id:expired.data.id}})).status,'EXPIRED');
 assert.equal(await prisma.notification.count({where:{recipientId:users.requester.id,needRequestId:expired.data.id,title:'Looking For request expired'}}),1);
 assert.equal((await clients.offerer.request('/needs/'+expired.data.id+'/offers',{method:'POST',body:expiredOffer})).status,409);
 assert.equal(await prisma.notification.count({where:{recipientId:users.requester.id,needRequestId:expired.data.id,title:'Looking For request expired'}}),1,'expiry notifications are idempotent');
 assert.equal((await clients.requester.request('/needs/'+rent.data.id+'/offers',{method:'POST',body:{listingId:rentListing.id,offeredPrice:200,quantity:1,availableStartDate:addDays(10),availableEndDate:addDays(12)}})).status,400,'self-offer rejected');
 const secondListing=await prisma.listing.create({data:{ownerId:users.other.id,categoryId:category.id,type:'RENT',title:'Alternate laptop',description:'Another laptop for a campus rental.',quantity:2,condition:'LIKE_NEW',dailyPrice:150,pickupLocation:'Library'}});listingIds.push(secondListing.id);
 const offer1=await clients.offerer.request('/needs/'+rent.data.id+'/offers',{method:'POST',body:{listingId:rentListing.id,offeredPrice:180,quantity:1,availableStartDate:addDays(10),availableEndDate:addDays(12),condition:'GOOD',message:'Available for your dates.'}});assert.equal(offer1.status,201);offerIds.push(offer1.data.id);
 const offer2=await clients.other.request('/needs/'+rent.data.id+'/offers',{method:'POST',body:{listingId:secondListing.id,offeredPrice:190,quantity:1,availableStartDate:addDays(10),availableEndDate:addDays(12)}});assert.equal(offer2.status,201);offerIds.push(offer2.data.id);
 assert.equal((await clients.other.request('/needs/'+rent.data.id+'/offers/'+offer1.data.id+'/accept',{method:'POST'})).status,404,'only requester sees/accepts offers');
 const rentDetail=await clients.requester.request('/needs/'+rent.data.id);assert.equal(rentDetail.data.offers.length,2);
 const acceptedRent=await clients.requester.request('/needs/'+rent.data.id+'/offers/'+offer1.data.id+'/accept',{method:'POST'});assert.equal(acceptedRent.status,200);bookingIds.push(acceptedRent.data.booking.id);
 assert.equal(acceptedRent.data.booking.status,'PENDING');
 assert.equal((await prisma.needOffer.findUnique({where:{id:offer2.data.id}})).status,'REJECTED');
 assert.equal((await clients.requester.request('/needs/'+rent.data.id+'/offers/'+offer2.data.id+'/accept',{method:'POST'})).status,409);
 assert.equal((await clients.offerer.request('/bookings/'+acceptedRent.data.booking.id+'/approve',{method:'POST'})).status,200);
 await prisma.booking.update({where:{id:acceptedRent.data.booking.id},data:{startDate:new Date(Date.now()-3*86400000),endDate:new Date(Date.now()-86400000)}});
 assert.equal((await clients.offerer.request('/bookings/'+acceptedRent.data.booking.id+'/activate',{method:'POST'})).status,200);
 assert.equal((await clients.offerer.request('/bookings/'+acceptedRent.data.booking.id+'/complete',{method:'POST',body:{}})).status,200);
 assert.equal((await prisma.needRequest.findUnique({where:{id:rent.data.id}})).status,'FULFILLED');

 const sale=await prisma.listing.create({data:{ownerId:users.offerer.id,categoryId:category.id,type:'SELL',title:'Offer used book',description:'A textbook for sale.',quantity:3,condition:'GOOD',salePrice:200,pickupLocation:'Library'}});listingIds.push(sale.id);
 const buy=await clients.requester.request('/needs',{method:'POST',body:{...baseNeed,title:'Need a textbook',requestType:'BUY',startDate:undefined,endDate:undefined,rentalDuration:undefined,desiredCondition:'FAIR',quantity:2,budgetMin:100,budgetMax:500}});assert.equal(buy.status,201);needIds.push(buy.data.id);
 const buyOffer=await clients.offerer.request('/needs/'+buy.data.id+'/offers',{method:'POST',body:{listingId:sale.id,offeredPrice:350,quantity:2,condition:'GOOD'}});assert.equal(buyOffer.status,201);offerIds.push(buyOffer.data.id);
 const acceptedBuy=await clients.requester.request('/needs/'+buy.data.id+'/offers/'+buyOffer.data.id+'/accept',{method:'POST'});assert.equal(acceptedBuy.status,200);purchaseIds.push(acceptedBuy.data.purchaseRequest.id);
 assert.equal(acceptedBuy.data.purchaseRequest.quantity,2);
 assert.equal((await clients.offerer.request('/purchases/'+acceptedBuy.data.purchaseRequest.id+'/accept',{method:'POST'})).status,200);
 const key=(await clients.requester.request('/transactions/key',{method:'POST'})).data.idempotencyKey;
 const txResult=await clients.requester.request('/transactions',{method:'POST',key,body:{purchaseRequestId:acceptedBuy.data.purchaseRequest.id}});assert.equal(txResult.status,201);transactionIds.push(txResult.data.transaction.id);
 assert.equal((await clients.requester.request('/transactions/'+txResult.data.transaction.id+'/resolve',{method:'POST',body:{outcome:'SUCCESS'}})).status,200);
 assert.equal((await prisma.listing.findUnique({where:{id:sale.id}})).quantity,1);
 assert.equal((await prisma.needRequest.findUnique({where:{id:buy.data.id}})).status,'FULFILLED');

 const plan=await prisma.subscriptionListing.create({data:{ownerId:users.offerer.id,categoryId:subscriptionCategory.id,name:'Cloud Storage Plus',description:'A cloud storage seat.',plan:'Plus',totalSeats:3,availableSeats:3,durationDays:120,startDate:new Date(Date.now()-86400000),expiryDate:new Date(Date.now()+120*86400000),pricePerSeat:300}});
 subscriptionIds.push(plan.id);
 const sub=await clients.requester.request('/needs',{method:'POST',body:{...baseNeed,title:'Need a cloud plan',requestType:'SUBSCRIPTION',startDate:undefined,endDate:undefined,rentalDuration:undefined,desiredCondition:undefined,subscriptionName:'Cloud Storage',desiredPlan:'Plus',desiredDurationDays:90,seats:2,quantity:2,budgetMin:100,budgetMax:1000}});assert.equal(sub.status,201);needIds.push(sub.data.id);
 const subOffer=await clients.offerer.request('/needs/'+sub.data.id+'/offers',{method:'POST',body:{subscriptionListingId:plan.id,offeredPrice:800,quantity:2,message:'Two seats available.'}});assert.equal(subOffer.status,201);offerIds.push(subOffer.data.id);
 const acceptedSub=await clients.requester.request('/needs/'+sub.data.id+'/offers/'+subOffer.data.id+'/accept',{method:'POST'});assert.equal(acceptedSub.status,200);membershipIds.push(acceptedSub.data.membership.id);
 assert.equal(acceptedSub.data.membership.seatCount,2);
 assert.equal((await clients.offerer.request('/subscriptions/memberships/'+acceptedSub.data.membership.id+'/approve',{method:'POST'})).status,200);
 assert.equal((await prisma.subscriptionListing.findUnique({where:{id:plan.id}})).availableSeats,1);
 const subKey=(await clients.requester.request('/transactions/key',{method:'POST'})).data.idempotencyKey;
 const subTx=await clients.requester.request('/transactions',{method:'POST',key:subKey,body:{membershipId:acceptedSub.data.membership.id}});assert.equal(subTx.status,201);transactionIds.push(subTx.data.transaction.id);
 assert.equal((await clients.requester.request('/transactions/'+subTx.data.transaction.id+'/resolve',{method:'POST',body:{outcome:'SUCCESS'}})).status,200);
 assert.equal((await prisma.needRequest.findUnique({where:{id:sub.data.id}})).status,'FULFILLED');
 const notes=await clients.requester.request('/notifications?paged=1&limit=50');assert.ok(notes.data.items.some(n=>n.category==='LOOKING_FOR'&&n.needRequestId===buy.data.id));
});
