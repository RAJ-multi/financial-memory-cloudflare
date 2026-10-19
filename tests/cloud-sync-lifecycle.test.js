import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY } from '../src/config.js';
import { resetStoreForTesting, runLegacySlotMigration, store } from '../src/store.js';
import {
  getCloudSyncState,
  handleCloudSyncAuthStateForTesting,
  mergeFinancialData,
  resetCloudSyncForTesting,
  syncNow
} from '../src/cloud-sync.js';
import { resetSupabaseClientForTesting, setSupabaseClientForTesting } from '../src/auth.js';

const USER_A = 'user-a';
const USER_B = 'user-b';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function accountSlotKey(userId) {
  return `${STORAGE_KEY}_account_${encodeURIComponent(userId)}`;
}

function financialData({ expenses = [], savings = [], deletedExpenseIds = [], deletedSavingIds = [] } = {}) {
  return {
    version: 1,
    settings: { currency: 'USD', dailyBudget: null, theme: 'system', backgroundPreset: 'default' },
    settingsUpdatedAt: 100,
    expenses,
    savings,
    deletedExpenseIds,
    deletedSavingIds
  };
}

function expense(id, amount = 10) {
  return {
    id,
    type: 'expense',
    amount,
    category: 'Food & Drinks',
    date: '2026-10-11',
    createdAt: 100,
    updatedAt: 100
  };
}

function createCloudClient({ rows = {}, readError = null, writeError = null, readOverride = null } = {}) {
  const writes = [];
  const selectCalls = [];

  return {
    writes,
    selectCalls,
    client: {
      from(table) {
        assert.equal(table, 'financial_memory_cloud');
        let selectedUserId = null;
        return {
          select() {
            return this;
          },
          eq(column, value) {
            assert.equal(column, 'user_id');
            selectedUserId = value;
            return this;
          },
          maybeSingle() {
            selectCalls.push(selectedUserId);
            const overridden = readOverride?.(selectedUserId);
            if (overridden) return overridden;
            if (readError) return Promise.resolve({ data: null, error: readError });
            const payload = rows[selectedUserId];
            return Promise.resolve({
              data: payload ? { payload: clone(payload), updated_at: '2026-10-11T00:00:00.000Z' } : null,
              error: null
            });
          },
          upsert(payload) {
            writes.push(clone(payload));
            if (!writeError) rows[payload.user_id] = clone(payload.payload);
            return Promise.resolve({ error: writeError });
          }
        };
      }
    }
  };
}

function createLocalStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

async function setSignedInUser(userId) {
  return handleCloudSyncAuthStateForTesting({
    user: { id: userId },
    isLoading: false
  });
}

async function setGuestUser() {
  return handleCloudSyncAuthStateForTesting({
    user: null,
    isLoading: false
  });
}

test.beforeEach(() => {
  resetCloudSyncForTesting();
  resetSupabaseClientForTesting();
  resetStoreForTesting();
});

test.afterEach(() => {
  resetCloudSyncForTesting();
  resetSupabaseClientForTesting();
});

test('guest data can be created and cleared locally without tombstones', () => {
  store.addExpense({ amount: 14, category: 'Food & Drinks', date: '2026-10-11' });
  store.addSaving({ amount: 30, date: '2026-10-11' });

  const cleared = store.deleteAllLocalData();

  assert.equal(cleared.expenses.length, 0);
  assert.equal(cleared.savings.length, 0);
  assert.deepEqual(cleared.deletedExpenseIds, []);
  assert.deepEqual(cleared.deletedSavingIds, []);
  assert.equal(cleared.settingsUpdatedAt, 0);
});

test('signing in with an empty local store restores cloud records without rewriting them', async () => {
  const cloud = financialData({ expenses: [expense('cloud-expense')] });
  const fake = createCloudClient({ rows: { [USER_A]: cloud } });
  setSupabaseClientForTesting(fake.client);

  const synced = await setSignedInUser(USER_A);

  assert.equal(synced, true);
  assert.deepEqual(store.getExpenses().map(item => item.id), ['cloud-expense']);
  assert.equal(fake.writes.length, 0, 'hydrating an unchanged cloud row must not upsert it');
  assert.equal(getCloudSyncState().status, 'synced');
});

test('sign out, local clear, and sign-in restore the account cloud copy', async () => {
  const cloud = financialData({ expenses: [expense('cloud-expense')] });
  const fake = createCloudClient({ rows: { [USER_A]: cloud } });
  setSupabaseClientForTesting(fake.client);

  await setSignedInUser(USER_A);
  await setGuestUser();
  assert.equal(store.getExpenses().length, 0, 'signed-out guest mode must not display account records');

  const cleared = store.deleteAllLocalData();
  assert.deepEqual(cleared.deletedExpenseIds, []);
  assert.deepEqual(cleared.deletedSavingIds, []);

  const synced = await setSignedInUser(USER_A);
  assert.equal(synced, true);
  assert.deepEqual(store.getExpenses().map(item => item.id), ['cloud-expense']);
  assert.equal(fake.writes.length, 0, 'a local reset must not overwrite the cloud row');
});

test('an unverified legacy local cache cannot reintroduce bulk-clear tombstones', async () => {
  const originalWindow = globalThis.window;
  const localStorage = createLocalStorage();
  globalThis.window = { localStorage };

  try {
    const cloud = financialData({ expenses: [expense('cloud-expense')] });
    const fake = createCloudClient({ rows: { [USER_A]: cloud } });
    setSupabaseClientForTesting(fake.client);

    await setSignedInUser(USER_A);
    resetCloudSyncForTesting(); // Simulate a reload after the old app left its owner key behind.
    store.saveData(financialData({
      deletedExpenseIds: ['cloud-expense']
    }));

    await setGuestUser();
    assert.equal(store.getExpenses().length, 0);
    assert.equal(localStorage.getItem('financial_memory_sync_owner'), null);

    const synced = await setSignedInUser(USER_A);
    assert.equal(synced, true);
    assert.deepEqual(store.getExpenses().map(item => item.id), ['cloud-expense']);
    assert.equal(fake.writes.length, 0);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('failed cloud reads are errors, never a new-account signal, and never overwrite local data', async () => {
  const fake = createCloudClient({ readError: new Error('read denied') });
  setSupabaseClientForTesting(fake.client);

  const firstTry = await setSignedInUser(USER_A);
  assert.equal(firstTry, false);
  assert.equal(fake.writes.length, 0, 'a failed read must never initialize or overwrite the account row');
  assert.equal(getCloudSyncState().status, 'error');

  // Local edits made under this account stay in that account's own cache.
  store.addExpense({ amount: 9, category: 'Food & Drinks', date: '2026-10-11' });

  const synced = await syncNow();

  assert.equal(synced, false);
  assert.equal(fake.writes.length, 0);
  assert.equal(store.getExpenses().length, 1, 'failed reads must leave local account data intact');
  assert.equal(getCloudSyncState().status, 'error');
  assert.match(getCloudSyncState().error, /read denied/);
  assert.equal(getCloudSyncState().userId, USER_A);
});

test('failed cloud writes are reported and never claim a successful sync', async () => {
  const fake = createCloudClient({
    rows: { [USER_A]: financialData({ expenses: [expense('cloud-expense')] }) },
    writeError: new Error('write rejected')
  });
  setSupabaseClientForTesting(fake.client);

  // Loading an existing row is read-only, so it succeeds before writes fail.
  assert.equal(await setSignedInUser(USER_A), true);
  store.addExpense({ amount: 9, category: 'Food & Drinks', date: '2026-10-11' });

  const synced = await syncNow();

  assert.equal(synced, false);
  assert.equal(fake.writes.length, 1);
  assert.equal(getCloudSyncState().status, 'error');
  assert.match(getCloudSyncState().message, /not confirmed/i);
  assert.match(getCloudSyncState().error, /write rejected/);
  assert.equal(store.getExpenses().length, 2, 'a failed write must not remove local account data');
});

test('single-record deletion remains a tombstoned cross-device sync operation', async () => {
  const first = expense('first-expense', 10);
  const second = expense('second-expense', 20);
  const fake = createCloudClient({
    rows: { [USER_A]: financialData({ expenses: [first, second] }) }
  });
  setSupabaseClientForTesting(fake.client);

  await setSignedInUser(USER_A);
  assert.equal(store.deleteExpense('first-expense'), true);

  const synced = await syncNow();
  assert.equal(synced, true);
  assert.equal(fake.writes.length, 1);
  assert.deepEqual(fake.writes[0].user_id, USER_A);
  assert.deepEqual(fake.writes[0].payload.deletedExpenseIds, ['first-expense']);
  assert.deepEqual(fake.writes[0].payload.expenses.map(item => item.id), ['second-expense']);

  const secondDevice = mergeFinancialData(
    financialData({ expenses: [first, second] }),
    fake.writes[0].payload
  );
  assert.deepEqual(secondDevice.expenses.map(item => item.id), ['second-expense']);
});

test('switching accounts hides the prior account until the new account loads', async () => {
  let resolveUserBRead;
  const userBRead = new Promise(resolve => {
    resolveUserBRead = resolve;
  });
  const fake = createCloudClient({
    rows: {
      [USER_A]: financialData({ expenses: [expense('account-a-expense')] }),
      [USER_B]: financialData({ expenses: [expense('account-b-expense')] })
    },
    readOverride: userId => userId === USER_B ? userBRead : null
  });
  setSupabaseClientForTesting(fake.client);

  await setSignedInUser(USER_A);
  assert.deepEqual(store.getExpenses().map(item => item.id), ['account-a-expense']);

  const switchPromise = setSignedInUser(USER_B);
  assert.equal(store.getExpenses().length, 0, 'account B must never see account A while loading');

  resolveUserBRead({
    data: {
      payload: financialData({ expenses: [expense('account-b-expense')] }),
      updated_at: '2026-10-11T00:00:00.000Z'
    },
    error: null
  });
  const synced = await switchPromise;

  assert.equal(synced, true);
  assert.deepEqual(store.getExpenses().map(item => item.id), ['account-b-expense']);
});

test('account A → guest → account B keeps each dataset isolated and keyed by user ID', async () => {
  const fake = createCloudClient({
    rows: {
      [USER_A]: financialData({ expenses: [expense('account-a-expense')] }),
      [USER_B]: financialData({ expenses: [expense('account-b-expense')] })
    }
  });
  setSupabaseClientForTesting(fake.client);

  assert.equal(await setSignedInUser(USER_A), true);
  assert.deepEqual(store.getExpenses().map(item => item.id), ['account-a-expense']);
  assert.equal(store.getActiveSlotForTesting(), accountSlotKey(USER_A), 'account caches are keyed by the stable user ID');

  await setGuestUser();
  assert.deepEqual(store.getExpenses(), [], 'logout must immediately hide account data');
  assert.deepEqual(store.getSavings(), []);
  assert.deepEqual(store.getData().deletedExpenseIds, []);
  assert.equal(store.getActiveSlotForTesting(), STORAGE_KEY);

  store.addExpense({ amount: 5, category: 'Food & Drinks', date: '2026-10-12', description: 'Guest only' });

  assert.equal(await setSignedInUser(USER_B), true);
  assert.deepEqual(store.getExpenses().map(item => item.id), ['account-b-expense'], 'account B must not receive guest or account A data');
  assert.equal(store.getActiveSlotForTesting(), accountSlotKey(USER_B));

  await setGuestUser();
  assert.deepEqual(store.getExpenses(), [], 'the guest session after switching accounts is clean too');

  assert.equal(await setSignedInUser(USER_A), true);
  assert.deepEqual(store.getExpenses().map(item => item.id), ['account-a-expense'], 'account A still loads only its own cloud data');
  assert.equal(fake.writes.length, 0, 'existing cloud rows are loaded, never overwritten');
});

test('guest data never enters an account, even when the cloud read confirms no row', async () => {
  const fake = createCloudClient();
  setSupabaseClientForTesting(fake.client);
  store.addExpense({ amount: 7, category: 'Food & Drinks', date: '2026-10-11', description: 'Guest only' });

  assert.equal(await setSignedInUser(USER_A), true);
  assert.deepEqual(store.getExpenses(), [], 'a new account starts empty, not with guest records');
  assert.equal(fake.writes.length, 1);
  assert.equal(fake.writes[0].user_id, USER_A);
  assert.deepEqual(fake.writes[0].payload.expenses, []);
  assert.deepEqual(fake.writes[0].payload.savings, []);
  assert.deepEqual(fake.writes[0].payload.deletedExpenseIds, []);
  assert.deepEqual(fake.writes[0].payload.deletedSavingIds, []);

  await setGuestUser();
  // The guest record was never uploaded to any account row.
  assert.equal(fake.writes.length, 1);
});

test('logout during an in-flight read keeps the clean guest session after the stale completion', async () => {
  let resolveRead;
  const pendingRead = new Promise(resolve => {
    resolveRead = resolve;
  });
  const fake = createCloudClient({
    rows: { [USER_A]: financialData({ expenses: [expense('cloud-expense')] }) },
    readOverride: userId => userId === USER_A ? pendingRead : null
  });
  setSupabaseClientForTesting(fake.client);

  const pending = setSignedInUser(USER_A);
  assert.deepEqual(store.getExpenses(), [], 'account data must not appear before its read completes');

  await setGuestUser();
  assert.deepEqual(store.getExpenses(), [], 'logout must show a clean guest session immediately');

  resolveRead({
    data: {
      payload: financialData({ expenses: [expense('cloud-expense')] }),
      updated_at: '2026-10-11T00:00:00.000Z'
    },
    error: null
  });
  assert.equal(await pending, false);
  assert.deepEqual(store.getExpenses(), [], 'a stale read completion must not update the guest session');
  assert.equal(fake.writes.length, 0);
  assert.equal(getCloudSyncState().status, 'guest');
});

test('a malformed existing cloud payload is not applied, overwritten, or replaced with guest data', async () => {
  const fake = createCloudClient({
    rows: { [USER_A]: { version: 1, settings: {}, expenses: 'broken', savings: [] } }
  });
  setSupabaseClientForTesting(fake.client);
  store.addExpense({ amount: 7, category: 'Food & Drinks', date: '2026-10-11', description: 'Guest only' });

  assert.equal(await setSignedInUser(USER_A), false);
  assert.deepEqual(store.getExpenses(), [], 'the guest slot must not leak into the account slot');
  assert.equal(fake.writes.length, 0, 'a malformed row must never be overwritten');
  assert.equal(getCloudSyncState().status, 'error');
  assert.equal(getCloudSyncState().userId, USER_A);
  assert.match(getCloudSyncState().error, /not applied/i);
});

test('legacy shared-slot data with a recorded owner moves to that owner\'s account slot', () => {
  const originalWindow = globalThis.window;
  const localStorage = createLocalStorage();
  globalThis.window = { localStorage };

  try {
    const legacyRaw = JSON.stringify(financialData({ expenses: [expense('legacy-expense')] }));
    localStorage.setItem(STORAGE_KEY, legacyRaw);
    localStorage.setItem('financial_memory_sync_owner', USER_A);

    runLegacySlotMigration();

    // The recorded owner's account slot now holds the legacy records...
    const accountRaw = JSON.parse(localStorage.getItem(accountSlotKey(USER_A)));
    assert.deepEqual(accountRaw.expenses.map(item => item.id), ['legacy-expense']);

    // ...while the shared guest slot keeps only preferences, never records
    // or tombstones that could be assigned to an account later.
    const guestRaw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    assert.deepEqual(guestRaw.expenses, []);
    assert.deepEqual(guestRaw.savings, []);
    assert.deepEqual(guestRaw.deletedExpenseIds, []);
    assert.deepEqual(guestRaw.deletedSavingIds, []);
    assert.equal(guestRaw.settings.currency, 'USD');

    // Only the owner's slot shows the migrated records.
    store.activateAccountSlot(USER_A);
    assert.deepEqual(store.getExpenses().map(item => item.id), ['legacy-expense']);
    store.activateGuestSlot();
    assert.deepEqual(store.getExpenses(), []);

    // The migration is one-time: a later shared-slot value cannot clobber
    // the established account cache.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(financialData({ expenses: [expense('newer-shared')] })));
    runLegacySlotMigration();
    assert.deepEqual(
      JSON.parse(localStorage.getItem(accountSlotKey(USER_A))).expenses.map(item => item.id),
      ['legacy-expense']
    );
    assert.deepEqual(
      JSON.parse(localStorage.getItem(STORAGE_KEY)).expenses.map(item => item.id),
      ['newer-shared']
    );
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('legacy guest data without a recorded owner is never assigned to an account', () => {
  const originalWindow = globalThis.window;
  const localStorage = createLocalStorage();
  globalThis.window = { localStorage };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(financialData({ expenses: [expense('guest-only-expense')] })));

    runLegacySlotMigration();

    for (const userId of [USER_A, USER_B]) {
      assert.equal(localStorage.getItem(accountSlotKey(userId)), null, 'no account may claim unowned guest data');
    }
    assert.deepEqual(
      JSON.parse(localStorage.getItem(STORAGE_KEY)).expenses.map(item => item.id),
      ['guest-only-expense'],
      'the guest dataset stays untouched'
    );
    // The migration stays eligible for a later run once ownership is known.
    assert.equal(localStorage.getItem('financial_memory_slots_v2_migrated'), null);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
