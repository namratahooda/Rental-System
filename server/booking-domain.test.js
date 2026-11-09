import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDailyAvailability,
  calculateProposal,
  calculateRentalAmount,
  isBookingTransitionAllowed,
  maxReservedQuantity,
  parseDateOnly,
  validateDateRange,
} from './booking-domain.js';

const d = (value) => parseDateOnly(value);

test('date-only inputs are strict UTC calendar dates and reject past, invalid, or reversed ranges', () => {
  assert.equal(parseDateOnly('2026-02-30'), null);
  assert.equal(parseDateOnly('2026-2-03'), null);
  assert.equal(validateDateRange('2026-11-09', '2026-11-10', new Date('2026-11-09T17:00:00Z')).days, 1);
  assert.match(validateDateRange('2026-11-08', '2026-11-10', new Date('2026-11-09T01:00:00Z')).error, /past/);
  assert.match(validateDateRange('2026-11-10', '2026-11-10').error, /after/);
});

test('daily and monthly pricing are calculated on the server using quantity and a 30-day monthly block', () => {
  const daily = calculateRentalAmount({ startDate: d('2026-11-10'), endDate: d('2026-11-13'), quantity: 2, priceUnit: 'DAILY', dailyPrice: 125, monthlyPrice: 2500 });
  assert.deepEqual(daily, { days: 3, rentalUnits: 3, unitPrice: 125, amount: 750 });
  const monthly = calculateRentalAmount({ startDate: d('2026-11-10'), endDate: d('2026-12-11'), quantity: 1, priceUnit: 'MONTHLY', dailyPrice: 125, monthlyPrice: 2500 });
  assert.equal(monthly.rentalUnits, 2);
  assert.equal(monthly.amount, 5000);
  assert.throws(() => calculateRentalAmount({ startDate: d('2026-11-10'), endDate: d('2026-11-11'), quantity: 0, priceUnit: 'DAILY', dailyPrice: 10 }), /positive/);
});

test('10%, 15%, and 20% proposals round to whole rupees and reject other percentages', () => {
  assert.equal(calculateProposal(1000, 10), 900);
  assert.equal(calculateProposal(1000, 15), 850);
  assert.equal(calculateProposal(1000, 20), 800);
  assert.throws(() => calculateProposal(1000, 25), /10%, 15%, or 20%/);
});

test('approved and active bookings reserve inventory while pending requests remain visibly provisional', () => {
  const bookings = [
    { startDate: d('2026-11-10'), endDate: d('2026-11-13'), quantity: 2, status: 'APPROVED' },
    { startDate: d('2026-11-11'), endDate: d('2026-11-12'), quantity: 1, status: 'PENDING' },
    { startDate: d('2026-11-13'), endDate: d('2026-11-15'), quantity: 3, status: 'ACTIVE' },
  ];
  const days = calculateDailyAvailability({ inventory: 3, bookings, from: '2026-11-10', to: '2026-11-15' });
  assert.deepEqual(days.map((day) => day.remaining), [1, 1, 1, 0, 0]);
  assert.deepEqual(days.map((day) => day.pending), [0, 1, 0, 0, 0]);
  assert.equal(maxReservedQuantity(bookings), 3);
});

test('non-overlapping ranges do not add inventory and booking transitions reject arbitrary changes', () => {
  const bookings = [
    { startDate: d('2026-11-10'), endDate: d('2026-11-12'), quantity: 2, status: 'APPROVED' },
    { startDate: d('2026-11-12'), endDate: d('2026-11-14'), quantity: 2, status: 'ACTIVE' },
  ];
  assert.equal(maxReservedQuantity(bookings), 2);
  assert.equal(isBookingTransitionAllowed('PENDING', 'APPROVED'), true);
  assert.equal(isBookingTransitionAllowed('APPROVED', 'COMPLETED'), false);
  assert.equal(isBookingTransitionAllowed('COMPLETED', 'ACTIVE'), false);
});
