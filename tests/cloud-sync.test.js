import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeFinancialData, normalizeFinancialData, validateFinancialDataPayload } from '../src/cloud-sync.js';

test('normalizes sync metadata and keeps existing records', () => {
  const data = normalizeFinancialData({
    settings: { currency: 'INR' },
    expenses: [{ id: 'local-expense', amount: 12 }],
    savings: []
  });
  assert.equal(data.settings.currency, 'INR');
  assert.equal(data.expenses.length, 1);
  assert.deepEqual(data.deletedExpenseIds, []);
  assert.equal(data.settingsUpdatedAt, 0);
});

test('merges local and remote records by stable ID', () => {
  const merged = mergeFinancialData(
    { settings: {}, expenses: [{ id: 'local', amount: 1, createdAt: 10 }], savings: [] },
    { settings: {}, expenses: [{ id: 'remote', amount: 2, createdAt: 20 }], savings: [] }
  );
  assert.deepEqual(merged.expenses.map(item => item.id).sort(), ['local', 'remote']);
});

test('newer record wins and deleted record IDs stay deleted', () => {
  const merged = mergeFinancialData(
    {
      settings: {},
      expenses: [{ id: 'e1', amount: 9, createdAt: 1, updatedAt: 300 }],
      deletedExpenseIds: ['e2'],
      savings: []
    },
    {
      settings: {},
      expenses: [
        { id: 'e1', amount: 5, createdAt: 1, updatedAt: 200 },
        { id: 'e2', amount: 8, createdAt: 2, updatedAt: 250 }
      ],
      savings: []
    }
  );
  assert.equal(merged.expenses.length, 1);
  assert.equal(merged.expenses[0].amount, 9);
  assert.deepEqual(merged.deletedExpenseIds, ['e2']);
});

test('newer settings win during conflict resolution', () => {
  const merged = mergeFinancialData(
    { settings: { currency: 'INR' }, settingsUpdatedAt: 500, expenses: [], savings: [] },
    { settings: { currency: 'USD' }, settingsUpdatedAt: 400, expenses: [], savings: [] }
  );
  assert.equal(merged.settings.currency, 'INR');
});

test('rejects malformed and unsupported cloud payloads instead of normalizing them to empty data', () => {
  assert.equal(validateFinancialDataPayload(null).valid, false);
  assert.equal(validateFinancialDataPayload('not-an-object').valid, false);
  assert.equal(validateFinancialDataPayload([]).valid, false);
  assert.equal(validateFinancialDataPayload({ version: 2, settings: {}, expenses: [], savings: [] }).valid, false);
  assert.equal(validateFinancialDataPayload({ version: 1, settings: {}, expenses: 'not-an-array', savings: [] }).valid, false);
  assert.equal(validateFinancialDataPayload({ version: 1, settings: {}, expenses: [{ amount: 5 }], savings: [] }).valid, false);
  assert.equal(validateFinancialDataPayload({ version: 1, settings: {}, expenses: [], savings: [], deletedExpenseIds: [42] }).valid, false);

  // Older payloads without deletion metadata remain accepted.
  const valid = validateFinancialDataPayload({
    version: 1,
    settings: { currency: 'USD' },
    expenses: [{ id: 'e1', amount: 5 }],
    savings: []
  });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.data.expenses.map(item => item.id), ['e1']);
  assert.deepEqual(valid.data.deletedExpenseIds, []);
  assert.deepEqual(valid.data.deletedSavingIds, []);
});
