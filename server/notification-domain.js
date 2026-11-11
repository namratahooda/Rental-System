const rules = [
  { category: 'PAYMENTS', high: /refund requested|payment failed|refund request/i, medium: /refund approved|refund rejected|refund processed|payment successful/i, match: /refund|payment|transaction/i },
  { category: 'MESSAGES', medium: /new message/i, match: /message|conversation/i },
  { category: 'REVIEWS', medium: /review/i, match: /review/i },
  { category: 'RENTALS', high: /new rental request|booking request/i, medium: /approved|declined|rejected|rental started|rental returned|discount proposal/i, match: /rental|booking|discount/i },
  { category: 'PURCHASES', high: /new purchase request/i, medium: /accepted|rejected|negotiation|completed|sold/i, match: /purchase|offer|sale|item sold/i },
  { category: 'SUBSCRIPTIONS', high: /new subscription seat request/i, medium: /approved|activated|expired|rejected/i, match: /subscription|membership|seat/i },
  { category: 'ACCOUNT', high: /access|security|account|suspend/i, medium: /profile|account/i, match: /access|security|account/i },
];
export function classifyNotification(title = '', message = '', lookingFor = false) {
  const text = String(title + ' ' + message).toLowerCase();
  if (lookingFor || /looking for/i.test(text)) {
    const priority = /new looking for offer|looking for offer accepted|from looking for/i.test(text) ? 'HIGH'
      : /looking for offer rejected|offer not selected|request fulfilled/i.test(text) ? 'MEDIUM' : 'LOW';
    return { category: 'LOOKING_FOR', priority };
  }
  const rule = rules.find((item) => item.match.test(text));
  const category = rule?.category || 'ACCOUNT';
  const priority = rule?.high?.test(text) ? 'HIGH' : rule?.medium?.test(text) ? 'MEDIUM' : 'LOW';
  return { category, priority };
}
export function orderNotifications(items, mode = 'important') {
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return [...items].sort((a, b) => {
    if (mode === 'oldest') return new Date(a.createdAt) - new Date(b.createdAt);
    if (mode === 'newest') return new Date(b.createdAt) - new Date(a.createdAt);
    if (a.isRead !== b.isRead) return Number(a.isRead) - Number(b.isRead);
    if (!a.isRead && rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}
