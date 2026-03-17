const test = require('node:test');
const assert = require('node:assert/strict');
const { orderVisibilityWhere, invoiceVisibilityWhere, paymentVisibilityWhere } = require('../src/utils/factoryVisibility');

test('tenant factory visibility builds scoped where clauses', () => {
  const req = { factory_ids: ['f1', 'f2'] };
  const orderWhere = orderVisibilityWhere(req);
  const invoiceWhere = invoiceVisibilityWhere(req);
  const paymentWhere = paymentVisibilityWhere(req);

  assert.deepEqual(orderWhere.OR[0].fulfillments.some.factory_id, { in: ['f1', 'f2'] });
  assert.deepEqual(invoiceWhere.OR[2], { order_id: null, factory_id: { in: ['f1', 'f2'] } });
  assert.deepEqual(paymentWhere.OR[2], { order_id: null, factory_id: { in: ['f1', 'f2'] } });
});
