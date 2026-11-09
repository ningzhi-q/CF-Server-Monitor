import assert from 'node:assert/strict';
import test from 'node:test';
import * as backend from '../src/utils/serverBilling.js';
import * as frontend from '../src/frontend/utils/server.js';
import { calculateFinanceSummary } from '../src/frontend/utils/finance.js';
import { LANGUAGE_CODES } from '../src/frontend/locales/index.js';

const NOW = Date.UTC(2026, 10, 9);

for (const [name, billing] of [['backend', backend], ['frontend', frontend]]) {
  test(`${name}: one-time billing normalizes and survives legacy price parsing`, () => {
    for (const alias of ['one_time', 'one-time', 'One time', '一次性']) {
      assert.equal(billing.normalizeBillingCycle(alias), 'one_time');
      assert.equal(billing.detectBillingCycle(`¥99/${alias}`), 'one_time');
    }
    assert.equal(billing.normalizeBillingCycle('year'), 'year');
    assert.equal(billing.normalizeBillingCycle(''), 'month');
  });

  test(`${name}: one-time and permanent entries never auto-renew`, () => {
    for (const flag of [true, 1, '1', 'true']) {
      assert.deepEqual(billing.renewExpireDateIfNeeded('2026-01-01', 'one_time', flag, NOW, 5), {
        expire_date: '2026-01-01', renewed: false
      });
      assert.deepEqual(billing.renewExpireDateIfNeeded('never', 'month', flag, NOW, 5), {
        expire_date: 'never', renewed: false
      });
    }
    assert.equal(billing.supportsAutoRenewal('one_time', '2027-01-01'), false);
    assert.equal(billing.supportsAutoRenewal('year', 'never'), false);
    assert.equal(billing.supportsAutoRenewal('year', '2027-01-01'), true);
    assert.equal(billing.isPermanentExpiration(''), false, 'unset is distinct from permanent');
  });

  test(`${name}: recurring renewal retains month-end and leap-year behavior`, () => {
    assert.deepEqual(billing.renewExpireDateIfNeeded('2026-01-31', 'month', '1', Date.UTC(2026, 0, 31)), {
      expire_date: '2026-02-28', renewed: true
    });
    assert.deepEqual(billing.renewExpireDateIfNeeded('2024-02-29', 'year', '1', Date.UTC(2024, 1, 29)), {
      expire_date: '2025-02-28', renewed: true
    });
    assert.deepEqual(billing.renewExpireDateIfNeeded('2026-11-12', 'month', '1', NOW, 5), {
      expire_date: '2026-12-12', renewed: true
    });
  });
}

test('one-time price labels are localized in every registered language', () => {
  const option = frontend.getBillingCycleOption('one_time');
  for (const language of LANGUAGE_CODES) {
    assert.ok(frontend.getLocalizedOptionField(option, 'label', language));
    assert.ok(frontend.getLocalizedOptionField(option, 'shortLabel', language));
    assert.match(frontend.formatBillingPrice({ price: '99', currency: '¥', billing_cycle: 'one_time' }, language), /^¥99\.00\//);
  }
  assert.equal(frontend.formatBillingPrice({ price: '99', currency: '¥', billing_cycle: 'one_time' }), '¥99.00/一次性');
});

test('one-time purchases have no recurring monthly cost and permanent purchases remain valid', () => {
  const server = { price: '99', currency: '¥', billing_cycle: 'one_time', expire_date: 'never' };
  assert.deepEqual(calculateFinanceSummary([server], undefined, NOW), {
    totalValueCNY: 99, remainingValueCNY: 99, monthlyAverageCostCNY: 0,
    configuredCount: 1, expiredCount: 0, missingExpireCount: 0
  });
  const finite = calculateFinanceSummary([{ ...server, expire_date: '2026-11-12' }], undefined, NOW);
  assert.equal(finite.remainingValueCNY, 99);
  assert.equal(finite.monthlyAverageCostCNY, 0);
  const expired = calculateFinanceSummary([{ ...server, expire_date: '2026-11-08' }], undefined, NOW);
  assert.equal(expired.remainingValueCNY, 0);
  assert.equal(expired.expiredCount, 1);
  const unset = calculateFinanceSummary([{ ...server, expire_date: '' }], undefined, NOW);
  assert.equal(unset.missingExpireCount, 1);
  const recurring = calculateFinanceSummary([{ ...server, billing_cycle: 'month' }], undefined, NOW);
  assert.equal(recurring.monthlyAverageCostCNY, 99);
  assert.equal(recurring.expiredCount, 0);
});
