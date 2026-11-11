import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNotification, orderNotifications } from './notification-domain.js';

test('notification titles map to categories and varied priorities', () => {
  assert.deepEqual(classifyNotification('New rental request'), { category: 'RENTALS', priority: 'HIGH' });
  assert.deepEqual(classifyNotification('Simulated refund processed'), { category: 'PAYMENTS', priority: 'MEDIUM' });
  assert.deepEqual(classifyNotification('New message'), { category: 'MESSAGES', priority: 'MEDIUM' });
  assert.deepEqual(classifyNotification('Rental returned'), { category: 'RENTALS', priority: 'MEDIUM' });
  assert.deepEqual(classifyNotification('Access request approved'), { category: 'ACCOUNT', priority: 'HIGH' });
});

test('important sorting puts unread high priority first and read records last', () => {
  const rows = [
    { id: 'read-high', isRead: true, priority: 'HIGH', createdAt: '2026-01-03' },
    { id: 'unread-low', isRead: false, priority: 'LOW', createdAt: '2026-01-04' },
    { id: 'unread-high-old', isRead: false, priority: 'HIGH', createdAt: '2026-01-01' },
    { id: 'unread-high-new', isRead: false, priority: 'HIGH', createdAt: '2026-01-02' },
  ];
  assert.deepEqual(orderNotifications(rows).map((x) => x.id), ['unread-high-new', 'unread-high-old', 'unread-low', 'read-high']);
  assert.deepEqual(orderNotifications(rows, 'oldest').map((x) => x.id), ['unread-high-old', 'unread-high-new', 'read-high', 'unread-low']);
});
