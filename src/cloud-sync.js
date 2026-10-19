import { DEFAULT_SETTINGS } from './config.js';
import { store } from './store.js';
import { getSupabase, subscribeAuth } from './auth.js';

const TABLE = 'financial_memory_cloud';

let initialized = false;
let activeUserId = null;
let activeGeneration = 0;
let readyUserId = null;
let activeOperation = null;
let syncTimer = null;
let applyingCloudData = false;
let storeUnsubscribe = null;
let authUnsubscribe = null;
let visibilityEventsRegistered = false;
const listeners = new Set();

let syncState = {
  status: 'idle',
  message: 'Cloud sync has not started.',
  error: null,
  lastSyncedAt: null,
  userId: null
};

function emitState(patch) {
  syncState = { ...syncState, ...patch };
  for (const listener of listeners) {
    try {
      listener(getCloudSyncState());
    } catch (error) {
      console.error('Cloud sync listener failed:', error);
    }
  }
}

function currentContext() {
  return activeUserId ? { userId: activeUserId, generation: activeGeneration } : null;
}

function isCurrent(context) {
  return Boolean(context) && activeUserId === context.userId && activeGeneration === context.generation;
}

function emitForContext(context, patch) {
  if (!isCurrent(context)) return false;
  emitState({ ...patch, userId: context.userId });
  return true;
}

export function getCloudSyncState() {
  return { ...syncState };
}

export function subscribeCloudSync(listener) {
  listeners.add(listener);
  try {
    listener(getCloudSyncState());
  } catch (error) {
    console.error('Cloud sync listener failed:', error);
  }
  return () => listeners.delete(listener);
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.length > 0))];
}

function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeFinancialData(input) {
  const data = input && typeof input === 'object' ? input : {};
  const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  return {
    ...data,
    version: 1,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    expenses: Array.isArray(data.expenses) ? data.expenses.filter(item => item && typeof item.id === 'string') : [],
    savings: Array.isArray(data.savings) ? data.savings.filter(item => item && typeof item.id === 'string') : [],
    deletedExpenseIds: uniqueIds(data.deletedExpenseIds),
    deletedSavingIds: uniqueIds(data.deletedSavingIds),
    settingsUpdatedAt: timestampOf(data.settingsUpdatedAt)
  };
}

/**
 * Validates a stored cloud payload before it can replace the selected account
 * slot. Older payloads without deletion metadata are accepted, but an unknown
 * version or a structurally incomplete/corrupt document is never normalized
 * into an accidental empty account.
 */
export function validateFinancialDataPayload(payload) {
  if (!isPlainObject(payload)) {
    return { valid: false, error: 'Cloud payload must be an object.' };
  }
  if (payload.version !== undefined && payload.version !== 1) {
    return { valid: false, error: 'Unsupported cloud payload version: ' + String(payload.version) + '.' };
  }
  if (!isPlainObject(payload.settings)) {
    return { valid: false, error: 'Cloud payload is missing settings.' };
  }

  for (const field of ['expenses', 'savings']) {
    if (!Array.isArray(payload[field])) {
      return { valid: false, error: 'Cloud payload is missing ' + field + '.' };
    }
    if (!payload[field].every(item => isPlainObject(item) && typeof item.id === 'string' && item.id.length > 0)) {
      return { valid: false, error: 'Cloud payload has an invalid ' + field + ' record.' };
    }
  }

  for (const field of ['deletedExpenseIds', 'deletedSavingIds']) {
    if (payload[field] !== undefined && (!Array.isArray(payload[field]) || !payload[field].every(id => typeof id === 'string' && id.length > 0))) {
      return { valid: false, error: 'Cloud payload has invalid ' + field + '.' };
    }
  }

  return { valid: true, data: normalizeFinancialData(payload) };
}

function mergeRecords(localRecords, cloudRecords, deletedIds) {
  const records = new Map();

  for (const item of cloudRecords) records.set(item.id, item);

  for (const item of localRecords) {
    const cloudItem = records.get(item.id);
    if (!cloudItem || timestampOf(item.updatedAt ?? item.createdAt) >= timestampOf(cloudItem.updatedAt ?? cloudItem.createdAt)) {
      records.set(item.id, item);
    }
  }

  return [...records.values()].filter(item => !deletedIds.has(item.id));
}

/**
 * Merges two copies of the same authenticated account. Guest data is never
 * passed to this function by the lifecycle code. Deletion tombstones are
 * preserved so an item deleted on one device does not reappear on another.
 */
export function mergeFinancialData(localInput, cloudInput) {
  const local = normalizeFinancialData(localInput);
  const cloud = normalizeFinancialData(cloudInput);
  const deletedExpenseIds = uniqueIds([...local.deletedExpenseIds, ...cloud.deletedExpenseIds]);
  const deletedSavingIds = uniqueIds([...local.deletedSavingIds, ...cloud.deletedSavingIds]);
  const deletedExpenses = new Set(deletedExpenseIds);
  const deletedSavings = new Set(deletedSavingIds);
  // On equal/legacy timestamps prefer cloud settings, so a second device with
  // default local preferences does not overwrite the account's settings.
  const preferLocalSettings = local.settingsUpdatedAt > cloud.settingsUpdatedAt;

  return {
    version: 1,
    settings: { ...(preferLocalSettings ? cloud.settings : local.settings), ...(preferLocalSettings ? local.settings : cloud.settings) },
    settingsUpdatedAt: Math.max(local.settingsUpdatedAt, cloud.settingsUpdatedAt),
    expenses: mergeRecords(local.expenses, cloud.expenses, deletedExpenses),
    savings: mergeRecords(local.savings, cloud.savings, deletedSavings),
    deletedExpenseIds,
    deletedSavingIds
  };
}

function emptyFinancialData() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    settingsUpdatedAt: 0,
    expenses: [],
    savings: [],
    deletedExpenseIds: [],
    deletedSavingIds: []
  };
}

function createAbortController() {
  return typeof AbortController === 'function' ? new AbortController() : null;
}

function withAbortSignal(query, controller) {
  if (controller && typeof query?.abortSignal === 'function') {
    return query.abortSignal(controller.signal);
  }
  return query;
}

function cancelActiveOperation() {
  if (!activeOperation) return;
  // Best-effort only: aborting the local request cannot guarantee that a
  // server-side write already accepted has been cancelled. Generation checks
  // keep any stale completion from touching the current session's state.
  activeOperation.controller?.abort();
  activeOperation = null;
}

function scheduleSync(delay = 700) {
  const context = currentContext();
  if (!context) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    if (isCurrent(context)) void syncNow();
  }, delay);
}

function applyActiveAccountData(context, data) {
  if (!isCurrent(context)) return false;
  const current = normalizeFinancialData(store.getData());
  const next = normalizeFinancialData(data);
  if (JSON.stringify(current) === JSON.stringify(next)) return true;

  applyingCloudData = true;
  try {
    // The selected slot was changed synchronously with the auth transition.
    // Check again immediately before writing so a stale completion cannot
    // alter a newly selected guest or different-account slot.
    if (!isCurrent(context)) return false;
    store.saveData(next);
    return true;
  } finally {
    applyingCloudData = false;
  }
}

async function readCloudRow(client, context, controller) {
  const query = withAbortSignal(
    client
      .from(TABLE)
      .select('payload, updated_at')
      .eq('user_id', context.userId),
    controller
  );
  return query.maybeSingle();
}

async function writeCloudRow(client, context, payload, controller) {
  const query = withAbortSignal(
    client
      .from(TABLE)
      .upsert({
        user_id: context.userId,
        payload,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' }),
    controller
  );
  return query;
}

async function performSync(context, operation) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase client is unavailable. Check your project URL and publishable key.');

  const isInitialLoad = readyUserId !== context.userId;
  emitForContext(context, {
    status: 'syncing',
    message: isInitialLoad ? 'Loading cloud data for this account…' : 'Syncing expenses, savings, and settings…',
    error: null,
    lastSyncedAt: null
  });

  const { data: cloudRow, error: readError } = await readCloudRow(client, context, operation.controller);
  if (readError) throw readError;
  if (!isCurrent(context)) return false;

  if (!cloudRow) {
    // A missing row is the only new-account signal. Neither guest data nor an
    // old account cache is used to initialize this account.
    const initialData = emptyFinancialData();
    if (!applyActiveAccountData(context, initialData) || !isCurrent(context)) return false;

    const { error: writeError } = await writeCloudRow(client, context, initialData, operation.controller);
    if (writeError) throw writeError;
    if (!isCurrent(context)) return false;

    readyUserId = context.userId;
    emitForContext(context, {
      status: 'synced',
      message: 'A new, empty cloud account was initialized.',
      error: null,
      lastSyncedAt: new Date().toISOString()
    });
    return true;
  }

  const validated = validateFinancialDataPayload(cloudRow.payload);
  if (!validated.valid) {
    throw new Error('Cloud data was not applied: ' + validated.error);
  }
  if (!isCurrent(context)) return false;

  if (isInitialLoad) {
    // Existing accounts load the confirmed cloud payload exactly as stored.
    // Do not merge the guest slot or silently rewrite a valid cloud record.
    if (!applyActiveAccountData(context, validated.data) || !isCurrent(context)) return false;
    readyUserId = context.userId;
    emitForContext(context, {
      status: 'synced',
      message: 'Cloud data loaded for this account.',
      error: null,
      lastSyncedAt: cloudRow.updated_at || new Date().toISOString()
    });
    return true;
  }

  // A subsequent sync can reconcile only this account's local cache with its
  // own cloud row. The active slot is account-specific, never guest data.
  const mergedData = mergeFinancialData(store.getData(), validated.data);
  if (!applyActiveAccountData(context, mergedData) || !isCurrent(context)) return false;

  const { error: writeError } = await writeCloudRow(client, context, mergedData, operation.controller);
  if (writeError) throw writeError;
  if (!isCurrent(context)) return false;

  emitForContext(context, {
    status: 'synced',
    message: 'Your expenses, savings, and settings are synced to this account.',
    error: null,
    lastSyncedAt: new Date().toISOString()
  });
  return true;
}

export async function syncNow() {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  const context = currentContext();
  if (!context) {
    emitState({
      status: 'guest',
      message: 'Sign in with Google to enable cloud sync.',
      error: null,
      lastSyncedAt: null,
      userId: null
    });
    return false;
  }

  if (activeOperation && activeOperation.context.userId === context.userId && activeOperation.context.generation === context.generation) {
    activeOperation.rerunRequested = true;
    return activeOperation.promise;
  }

  const operation = {
    context,
    controller: createAbortController(),
    rerunRequested: false,
    promise: null
  };
  const task = performSync(context, operation)
    .catch(error => {
      // An aborted or superseded request is intentionally silent. It belongs
      // to a session that is no longer active and cannot update its UI state.
      if (isCurrent(context)) {
        console.error('Cloud sync failed:', error);
        emitForContext(context, {
          status: 'error',
          message: 'Cloud sync failed. The cloud update was not confirmed; your local data remains available on this device.',
          error: error?.message || 'Unknown cloud sync error',
          lastSyncedAt: null
        });
      }
      return false;
    });
  operation.promise = task;
  activeOperation = operation;

  try {
    return await task;
  } finally {
    if (activeOperation === operation) {
      activeOperation = null;
      if (operation.rerunRequested && isCurrent(context)) scheduleSync(100);
    }
  }
}

function transitionToGuest() {
  activeGeneration += 1;
  cancelActiveOperation();
  readyUserId = null;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  activeUserId = null;
  // This immediately removes authenticated data and starts a clean guest
  // session; it never restores a prior guest dataset and never touches the
  // account's cloud row.
  store.resetGuestSlot();
  emitState({
    status: 'guest',
    message: 'Sign in with Google to enable cloud sync.',
    error: null,
    lastSyncedAt: null,
    userId: null
  });
}

function transitionToAccount(userId) {
  activeGeneration += 1;
  cancelActiveOperation();
  readyUserId = null;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  activeUserId = userId;
  // Switch before the read starts: guest/A data is never shown as user B.
  store.activateAccountSlot(userId);
}

function handleAuthState(authState) {
  const userId = authState?.user?.id || null;

  if (!userId) {
    if (authState?.isLoading) {
      // Do not display a cached account while the session is being restored.
      // The guest slot is already active, so no account data can be shown.
      if (!activeUserId) {
        emitState({ status: 'checking', message: 'Checking your account session…', error: null, lastSyncedAt: null, userId: null });
      }
      return;
    }
    if (activeUserId) {
      transitionToGuest();
    } else {
      // Initial unauthenticated startup and repeated guest notifications must
      // retain the persisted guest slot. Only an account-to-guest transition
      // starts a clean guest session.
      emitState({
        status: 'guest',
        message: 'Sign in with Google to enable cloud sync.',
        error: null,
        lastSyncedAt: null,
        userId: null
      });
    }
    return;
  }

  if (activeUserId !== userId) transitionToAccount(userId);
  if (readyUserId === userId) return;
  void syncNow();
}

export function initCloudSync() {
  if (initialized) return;
  initialized = true;

  storeUnsubscribe = store.subscribe(() => {
    if (!applyingCloudData && activeUserId && readyUserId === activeUserId) scheduleSync();
  });

  authUnsubscribe = subscribeAuth(handleAuthState);

  if (!visibilityEventsRegistered && typeof window !== 'undefined') {
    window.addEventListener('online', () => scheduleSync(100));
    window.addEventListener('focus', () => scheduleSync(100));
    visibilityEventsRegistered = true;
  }
}

// Test-only lifecycle controls let Node tests model Supabase auth transitions
// deterministically while keeping the browser-facing API small.

/** Applies an auth transition and awaits the sync it started, if any. */
export async function handleCloudSyncAuthStateForTesting(authState) {
  handleAuthState({ isLoading: false, ...authState });
  const operation = activeOperation;
  return operation ? await operation.promise : false;
}

/** Applies an auth transition without awaiting any resulting sync. */
export function setCloudSyncAuthStateForTesting(authState) {
  handleAuthState({ isLoading: false, ...authState });
}

/** Resets module state between isolated cloud-sync tests. */
export function resetCloudSyncForTesting() {
  activeGeneration += 1;
  cancelActiveOperation();
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  storeUnsubscribe?.();
  authUnsubscribe?.();
  storeUnsubscribe = null;
  authUnsubscribe = null;
  initialized = false;
  activeUserId = null;
  readyUserId = null;
  applyingCloudData = false;
  listeners.clear();
  syncState = {
    status: 'idle',
    message: 'Cloud sync has not started.',
    error: null,
    lastSyncedAt: null,
    userId: null
  };
}
