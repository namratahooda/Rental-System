const DAY_MS = 24 * 60 * 60 * 1000;
const RESERVED_STATUSES = new Set(['APPROVED', 'ACTIVE']);

export function parseDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function dateKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

export function utcToday(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function rentalDayCount(startDate, endDate) {
  return Math.round((endDate.getTime() - startDate.getTime()) / DAY_MS);
}

export function validateDateRange(startText, endText, now = new Date()) {
  const startDate = parseDateOnly(startText);
  const endDate = parseDateOnly(endText);
  if (!startDate || !endDate) return { error: 'Choose valid start and end dates.' };
  if (startDate < utcToday(now)) return { error: 'Rental dates cannot start in the past.' };
  if (endDate <= startDate) return { error: 'The end date must be after the start date.' };
  return { startDate, endDate, days: rentalDayCount(startDate, endDate) };
}

export function calculateRentalAmount({ startDate, endDate, quantity, priceUnit, dailyPrice, monthlyPrice }) {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Quantity must be a positive whole number.');
  const days = rentalDayCount(startDate, endDate);
  if (days < 1) throw new Error('The end date must be after the start date.');
  const unitPrice = priceUnit === 'DAILY' ? dailyPrice : priceUnit === 'MONTHLY' ? monthlyPrice : null;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw new Error('That rental price unit is not available for this listing.');
  const rentalUnits = priceUnit === 'DAILY' ? days : Math.ceil(days / 30);
  const amount = Math.round(unitPrice * rentalUnits * quantity);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 2_147_483_647) throw new Error('The calculated rental amount is invalid.');
  return { days, rentalUnits, unitPrice, amount };
}

export function calculateProposal(originalAmount, percentage) {
  if (!Number.isInteger(originalAmount) || originalAmount < 1) throw new Error('The original amount is invalid.');
  if (![10, 15, 20].includes(percentage)) throw new Error('Choose a 10%, 15%, or 20% discount.');
  return Math.round(originalAmount * (100 - percentage) / 100);
}

export function calculateDailyAvailability({ inventory, bookings, from, to }) {
  const first = parseDateOnly(from);
  const afterLast = parseDateOnly(to);
  if (!first || !afterLast || afterLast <= first) throw new Error('Choose a valid availability date range.');
  const days = [];
  for (let time = first.getTime(); time < afterLast.getTime(); time += DAY_MS) {
    const date = new Date(time);
    const key = dateKey(date);
    const overlapping = bookings.filter((booking) => booking.startDate < new Date(time + DAY_MS) && booking.endDate > date);
    const reserved = overlapping.filter((booking) => RESERVED_STATUSES.has(booking.status)).reduce((sum, booking) => sum + booking.quantity, 0);
    const pending = overlapping.filter((booking) => booking.status === 'PENDING').length;
    days.push({ date: key, remaining: Math.max(0, inventory - reserved), pending });
  }
  return days;
}

export function maxReservedQuantity(bookings) {
  const events = [];
  for (const booking of bookings) {
    if (!RESERVED_STATUSES.has(booking.status)) continue;
    events.push({ time: booking.startDate.getTime(), quantity: booking.quantity });
    events.push({ time: booking.endDate.getTime(), quantity: -booking.quantity });
  }
  events.sort((a, b) => a.time - b.time || a.quantity - b.quantity);
  let current = 0;
  let max = 0;
  for (const event of events) {
    current += event.quantity;
    max = Math.max(max, current);
  }
  return max;
}

export function isBookingTransitionAllowed(from, to) {
  return ({
    PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
    APPROVED: ['ACTIVE', 'CANCELLED'],
    ACTIVE: ['COMPLETED'],
    REJECTED: [],
    CANCELLED: [],
    COMPLETED: [],
  })[from]?.includes(to) ?? false;
}
