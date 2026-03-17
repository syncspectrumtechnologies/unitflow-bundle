const test = require('node:test');
const assert = require('node:assert/strict');
const {
  completionStatusFromInvoiceStatus,
  deriveInvoiceStatusFromPaidAmount,
  validateDispatchAllocationTotals
} = require('../src/domain');

test('invoice completion status is derived correctly', () => {
  assert.equal(completionStatusFromInvoiceStatus('PAID'), 'COMPLETED');
  assert.equal(completionStatusFromInvoiceStatus('VOID'), 'VOID');
  assert.equal(completionStatusFromInvoiceStatus('PENDING'), 'PENDING');
});

test('payment status derivation supports partial and full payment', () => {
  assert.equal(deriveInvoiceStatusFromPaidAmount({ invoiceStatus: 'PENDING', paidAmount: 0, totalAmount: 100 }), 'PENDING');
  assert.equal(deriveInvoiceStatusFromPaidAmount({ invoiceStatus: 'PENDING', paidAmount: 25, totalAmount: 100 }), 'PARTIALLY_PAID');
  assert.equal(deriveInvoiceStatusFromPaidAmount({ invoiceStatus: 'PARTIALLY_PAID', paidAmount: 100, totalAmount: 100 }), 'PAID');
});

test('dispatch allocation validation protects inventory commitment totals', () => {
  const valid = validateDispatchAllocationTotals(
    [{ product_id: 'p1', quantity: 10 }],
    [{ product_id: 'p1', quantity: 6 }, { product_id: 'p1', quantity: 4 }]
  );
  const invalid = validateDispatchAllocationTotals(
    [{ product_id: 'p1', quantity: 10 }],
    [{ product_id: 'p1', quantity: 9 }]
  );

  assert.equal(valid.ok, true);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.ordered_quantity, 10);
  assert.equal(invalid.allocated_quantity, 9);
});
