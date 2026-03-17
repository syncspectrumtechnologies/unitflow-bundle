const test = require('node:test');
const assert = require('node:assert/strict');
const {
  capabilitiesForRoles,
  requiredCapsFromPermissionKeys,
  hasRequiredCapabilities,
  normalizeRoleName
} = require('../src/utils/roleAccess');

test('authorization maps route permissions to capabilities', () => {
  const required = requiredCapsFromPermissionKeys(['orders.view', 'payments.create']);
  const userCaps = capabilitiesForRoles(['sales', 'finance']);
  assert.equal(normalizeRoleName('sales manager'), 'SALES_MANAGER');
  assert.equal(required.has('ORDERS_VIEW'), true);
  assert.equal(required.has('PAYMENTS_MANAGE'), true);
  assert.equal(hasRequiredCapabilities(userCaps, required), true);
});
