const prisma = require('../config/db');
const { env } = require('../config/env');

async function ensureDefaultPlans() {
  const defs = [
    {
      code: 'SINGLE_USER',
      name: 'Single User',
      description: 'Single active user seat, one active device at a time.',
      plan_type: 'SINGLE_USER',
      seat_limit: 1,
      monthly_price_minor: env.singleMonthlyMinor,
      yearly_price_minor: env.singleYearlyMinor,
      trial_days: 0,
      feature_limits_json: {
        max_users: 1,
        max_active_devices_per_seat: 1,
        mobile_companion_access: false,
        api_access: false,
        plan_family: 'single'
      }
    },
    {
      code: 'MULTI_USER',
      name: 'Multi User',
      description: 'Team plan for small factories and warehouses.',
      plan_type: 'MULTI_USER',
      seat_limit: env.multiSeatLimit,
      monthly_price_minor: env.multiMonthlyMinor,
      yearly_price_minor: env.multiYearlyMinor,
      trial_days: 0,
      feature_limits_json: {
        max_users: env.multiSeatLimit,
        max_active_devices_per_seat: 2,
        mobile_companion_access: false,
        api_access: false,
        plan_family: 'multi'
      }
    }
  ];

  for (const def of defs) {
    await prisma.subscriptionPlan.upsert({
      where: { code: def.code },
      update: def,
      create: def
    });
  }
}

async function getPlanByCode(code) {
  return prisma.subscriptionPlan.findFirst({ where: { code, is_active: true } });
}

async function listActivePlans() {
  return prisma.subscriptionPlan.findMany({
    where: { is_active: true },
    orderBy: { created_at: 'asc' }
  });
}

module.exports = { ensureDefaultPlans, getPlanByCode, listActivePlans };
