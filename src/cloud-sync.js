import { DEFAULT_SETTINGS } from './config.js';
import { store } from './store.js';
import { getSupabase, subscribeAuth } from './auth.js';

const TABLE = 'financial_memory_cloud';
const OWNER_KEY = 'financial_memory_sync_owner';

let initialized = false;
let activeUserId = null;
let readyUserId = null;
let initializingUserId = null;
let syncPromise = null;
let rerunRequested = false;
let syncTimer = null;
let applyingCloudData = false;
let memoryOwner = null;
let storeUnsubscribe = null;
let authUnsubscribe = null;
let visibilityEventsRegistered = false;
const listeners = new Set();

let syncState = {
  status: 'idle',
  message: 'Cloud sync has not started.',
  error: null,
  lastSyncedAt: null
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
 * Merge records by ID and preserve deletion tombstones so an item deleted on one
 * device does not reappear after that device syncs. Newer edits win by timestamp.
 */
export function mergeFinancialData(localInput, cloudInput) {
  const local = normalizeFinancialData(localInput);
  const cloud = normalizeFinancialData(cloudInput);
  const deletedExpenseIds = uniqueIds([...local.deletedExpenseIds, ...cloud.deletedExpenseIds]);
  const deletedSavingIds = uniqueIds([...local.deletedSavingIds, ...cloud.deletedSavingIds]);
  const deletedExpenses = new Set(deletedExpenseIds);
  const deletedSavings = new Set(deletedSavingIds);
  // On equal/legacy timestamps prefer cloud settings, so a second device with default local preferences does not overwrite the account's settings.
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

function readSyncOwner() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(OWNER_KEY);
    }
  } catch {
    // Continue with in-memory ownership in restricted browser contexts.
  }
  return memoryOwner;
}

function writeSyncOwner(userId) {
  memoryOwner = userId;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(OWNER_KEY, userId);
    }
  } catch {
    // The app remains usable even if ownership metadata cannot be persisted.
  }
}

const memorySnapshots = new Map();

function snapshotKey(userId) {
  return `financial_memory_sync_snapshot_${userId}`;
}

function readUserSnapshot(userId) {
  if (!userId) return null;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(snapshotKey(userId));
      if (raw) return normalizeFinancialData(JSON.parse(raw));
    }
  } catch {
    // Fall back to the in-memory snapshot when storage is restricted or malformed.
  }
  return memorySnapshots.get(userId) || null;
}

function writeUserSnapshot(userId, data) {
  if (!userId) return;
  const snapshot = normalizeFinancialData(data);
  memorySnapshots.set(userId, snapshot);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(snapshotKey(userId), JSON.stringify(snapshot));
    }
  } catch {
    // A failed snapshot must not prevent cloud sync or local storage from working.
  }
}

function scheduleSync(delay = 700) {
  if (!activeUserId) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncNow();
  }, delay);
}

function applyLocalData(data) {
  const current = normalizeFinancialData(store.getData());
  const next = normalizeFinancialData(data);
  if (JSON.stringify(current) === JSON.stringify(next)) return;

  applyingCloudData = true;
  try {
    store.saveData(next);
  } finally {
    applyingCloudData = false;
  }
}

async function performSync(userId) {
  const client = getSupabase();
  if (!client) throw new Error('Supabase client is unavailable. Check your project URL and publishable key.');

  emitState({
    status: 'syncing',
    message: 'Syncing expenses, savings, and settings…',
    error: null
  });

  const { data: cloudRow, error: readError } = await client
    .from(TABLE)
    .select('payload, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (readError) throw readError;
  if (activeUserId !== userId) return false;

  let localData = normalizeFinancialData(store.getData());
  const ownerId = readSyncOwner();
  let mergedData;

  if (ownerId && ownerId !== userId) {
    // Keep the previous account's local copy before switching account data.
    writeUserSnapshot(ownerId, localData);
    // Restore this account's last local snapshot (if any), never mix two users' data.
    localData = readUserSnapshot(userId) || emptyFinancialData();
    mergedData = cloudRow?.payload
      ? mergeFinancialData(localData, cloudRow.payload)
      : localData;
  } else if (cloudRow?.payload) {
    // On first sign-in, merge guest records into the account; on later syncs,
    // merge by stable IDs and carry tombstones so deletions propagate.
    mergedData = mergeFinancialData(localData, cloudRow.payload);
  } else {
    // First sync for this account: preserve and upload the current local data.
    mergedData = localData;
  }

  applyLocalData(mergedData);

  const { error: writeError } = await client
    .from(TABLE)
    .upsert({
      user_id: userId,
      payload: mergedData,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });

  if (writeError) throw writeError;
  if (activeUserId !== userId) return false;

  writeSyncOwner(userId);
  writeUserSnapshot(userId, mergedData);
  readyUserId = userId;
  const lastSyncedAt = new Date().toISOString();
  emitState({
    status: 'synced',
    message: 'Your expenses, savings, and settings are synced to your account.',
    error: null,
    lastSyncedAt
  });
  return true;
}

export async function syncNow() {
  const userId = activeUserId;
  if (!userId) {
    emitState({
      status: 'guest',
      message: 'Sign in with Google to enable cloud sync.',
      error: null
    });
    return false;
  }

  if (syncPromise) {
    rerunRequested = true;
    return syncPromise;
  }

  const task = performSync(userId)
    .catch(error => {
      console.error('Cloud sync failed:', error);
      emitState({
        status: 'error',
        message: 'Cloud sync failed. Your local data remains available on this device.',
        error: error?.message || 'Unknown cloud sync error'
      });
      return false;
    });

  syncPromise = task;
  try {
    return await task;
  } finally {
    if (syncPromise === task) syncPromise = null;
    if (rerunRequested && activeUserId) {
      rerunRequested = false;
      scheduleSync(100);
    }
  }
}

function handleAuthState(authState) {
  const userId = authState?.user?.id || null;

  if (!userId) {
    if (authState?.isLoading) {
      emitState({ status: 'checking', message: 'Checking your account session…', error: null });
      return;
    }

    activeUserId = null;
    readyUserId = null;
    initializingUserId = null;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    emitState({
      status: 'guest',
      message: 'Sign in with Google to enable cloud sync.',
      error: null
    });
    return;
  }

  if (activeUserId !== userId) {
    activeUserId = userId;
    readyUserId = null;
    initializingUserId = null;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
  }

  if (readyUserId === userId || initializingUserId === userId || syncPromise) return;
  initializingUserId = userId;
  void syncNow().finally(() => {
    if (initializingUserId === userId) initializingUserId = null;
  });
}

export function initCloudSync() {
  if (initialized) return;
  initialized = true;

  storeUnsubscribe = store.subscribe(() => {
    if (!applyingCloudData && activeUserId && readyUserId === activeUserId) {
      scheduleSync();
    }
  });

  authUnsubscribe = subscribeAuth(handleAuthState);

  if (!visibilityEventsRegistered && typeof window !== 'undefined') {
    window.addEventListener('online', () => scheduleSync(100));
    window.addEventListener('focus', () => scheduleSync(100));
    visibilityEventsRegistered = true;
  }
}

