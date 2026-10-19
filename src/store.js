import { STORAGE_KEY, DEFAULT_SETTINGS, FIXED_CATEGORIES } from './config.js';
import { round2 } from './calculations.js';

// In-memory fallback for testing in Node.js
let memoryStorage = new Map();
let activeStorageKey = STORAGE_KEY;
const LEGACY_SYNC_OWNER_KEY = 'financial_memory_sync_owner';
const LEGACY_SLOT_MIGRATION_KEY = 'financial_memory_slots_v2_migrated';

function createInitialData() {
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

function accountStorageKey(userId) {
  return `${STORAGE_KEY}_account_${encodeURIComponent(userId)}`;
}

function getStorage() {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return {
    getItem: (key) => memoryStorage.get(key) || null,
    setItem: (key, val) => { memoryStorage.set(key, val); },
    removeItem: (key) => { memoryStorage.delete(key); }
  };
}

/**
 * Older cloud-sync builds used the guest storage key as the active account
 * data too, while recording the last account owner separately. Move that
 * known-owned copy out of the guest slot once so upgrading users do not see a
 * previous account's records after logout. The original cloud row remains the
 * source of truth when that account next signs in. A guest dataset without a
 * recorded owner is never assigned to any account.
 */
export function runLegacySlotMigration() {
  const storage = getStorage();
  try {
    if (storage.getItem(LEGACY_SLOT_MIGRATION_KEY)) return;
    const legacyOwner = storage.getItem(LEGACY_SYNC_OWNER_KEY);
    const legacyRaw = storage.getItem(STORAGE_KEY);
    if (!legacyOwner || !legacyRaw) return;

    const accountKey = accountStorageKey(legacyOwner);
    if (!storage.getItem(accountKey)) storage.setItem(accountKey, legacyRaw);

    let legacySettings = {};
    try {
      const parsed = JSON.parse(legacyRaw);
      if (parsed?.settings && typeof parsed.settings === 'object') legacySettings = parsed.settings;
    } catch {
      // Use default guest settings when the old shared value is malformed.
    }
    const guest = createInitialData();
    // Match the product's existing local-clear behavior: preserve appearance
    // and currency, but never carry records, tombstones, or a daily budget.
    guest.settings = {
      dailyBudget: null,
      theme: legacySettings.theme || DEFAULT_SETTINGS.theme,
      backgroundPreset: legacySettings.backgroundPreset || DEFAULT_SETTINGS.backgroundPreset,
      currency: legacySettings.currency || DEFAULT_SETTINGS.currency
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(guest));
    storage.setItem(LEGACY_SLOT_MIGRATION_KEY, '1');
  } catch {
    // A blocked localStorage context simply keeps the existing compatibility
    // behavior; sync remains available through the in-memory fallback.
  }
}

export function generateId(prefix = 'item') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

class Store {
  constructor() {
    this.listeners = [];
    runLegacySlotMigration();
  }

  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.getData());
      } catch (err) {
        console.error('Error in store listener:', err);
      }
    }
  }

  getData() {
    const storage = getStorage();
    const raw = storage.getItem(activeStorageKey);
    if (!raw) {
      const initial = createInitialData();
      // Reading an empty slot should not notify subscribers. Slot activation does
      // that explicitly after it has made the selected dataset current.
      storage.setItem(activeStorageKey, JSON.stringify(initial));
      return initial;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.settings) parsed.settings = { ...DEFAULT_SETTINGS };
      if (!parsed.settings.currency) parsed.settings.currency = 'USD';
      if (!Array.isArray(parsed.expenses)) parsed.expenses = [];
      if (!Array.isArray(parsed.savings)) parsed.savings = [];
      return parsed;
    } catch {
      const reset = createInitialData();
      storage.setItem(activeStorageKey, JSON.stringify(reset));
      return reset;
    }
  }

  saveData(data) {
    const storage = getStorage();
    if (!Number.isFinite(Number(data.settingsUpdatedAt))) data.settingsUpdatedAt = 0;
    if (!Array.isArray(data.deletedExpenseIds)) data.deletedExpenseIds = [];
    if (!Array.isArray(data.deletedSavingIds)) data.deletedSavingIds = [];
    storage.setItem(activeStorageKey, JSON.stringify(data));
    this.notify();
  }

  /**
   * Selects the compatible legacy guest slot. It is intentionally independent
   * of every signed-in account cache.
   */
  activateGuestSlot() {
    activeStorageKey = STORAGE_KEY;
    const data = this.getData();
    this.notify();
    return data;
  }

  /**
   * Starts a clean guest session without touching any authenticated account
   * slot. The default dataset intentionally has no records or tombstones.
   */
  resetGuestSlot() {
    activeStorageKey = STORAGE_KEY;
    const fresh = createInitialData();
    this.saveData(fresh);
    return fresh;
  }

  /**
   * Selects a local cache that belongs only to the stable Supabase user ID.
   * This cache is never shared with guest mode or a different account.
   */
  activateAccountSlot(userId) {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new Error('A stable account user ID is required to select an account slot.');
    }
    activeStorageKey = accountStorageKey(userId);
    const data = this.getData();
    this.notify();
    return data;
  }

  getActiveSlotForTesting() {
    return activeStorageKey;
  }

  getSettings() {
    return this.getData().settings;
  }

  updateSettings(partial) {
    const data = this.getData();
    data.settings = { ...data.settings, ...partial };
    data.settingsUpdatedAt = Date.now();
    this.saveData(data);
    return data.settings;
  }

  setDailyBudget(amount) {
    const num = amount === null || amount === '' ? null : round2(amount);
    return this.updateSettings({ dailyBudget: num });
  }

  setTheme(theme) {
    return this.updateSettings({ theme });
  }

  setBackgroundPreset(preset) {
    return this.updateSettings({ backgroundPreset: preset });
  }

  setCurrency(currency) {
    const code = (currency || 'USD').toUpperCase();
    return this.updateSettings({ currency: code });
  }

  getExpenses() {
    return this.getData().expenses;
  }

  addExpense({ amount, category, date, description = '' }) {
    if (!amount || Number(amount) <= 0) {
      throw new Error('Expense amount must be a positive number.');
    }
    if (!category || !FIXED_CATEGORIES.includes(category)) {
      throw new Error('Valid expense category is required.');
    }
    if (!date) {
      throw new Error('Expense date is required.');
    }

    const data = this.getData();
    const newExpense = {
      id: generateId('exp'),
      type: 'expense',
      amount: round2(amount),
      category,
      date,
      description: description.trim(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    data.deletedExpenseIds = Array.isArray(data.deletedExpenseIds) ? data.deletedExpenseIds : [];
    data.expenses.push(newExpense);
    this.saveData(data);
    return newExpense;
  }

  updateExpense(id, { amount, category, date, description = '' }) {
    if (!amount || Number(amount) <= 0) {
      throw new Error('Expense amount must be a positive number.');
    }
    if (!category || !FIXED_CATEGORIES.includes(category)) {
      throw new Error('Valid expense category is required.');
    }
    if (!date) {
      throw new Error('Expense date is required.');
    }

    const data = this.getData();
    const idx = data.expenses.findIndex(e => e.id === id);
    if (idx === -1) {
      throw new Error('Expense not found.');
    }
    data.expenses[idx] = {
      ...data.expenses[idx],
      amount: round2(amount),
      category,
      date,
      description: description.trim(),
      updatedAt: Date.now()
    };
    this.saveData(data);
    return data.expenses[idx];
  }

  deleteExpense(id) {
    const data = this.getData();
    const initialLen = data.expenses.length;
    data.expenses = data.expenses.filter(e => e.id !== id);
    if (data.expenses.length !== initialLen) {
      data.deletedExpenseIds = Array.isArray(data.deletedExpenseIds) ? data.deletedExpenseIds : [];
      if (!data.deletedExpenseIds.includes(id)) data.deletedExpenseIds.push(id);
      this.saveData(data);
      return true;
    }
    return false;
  }

  getSavings() {
    return this.getData().savings;
  }

  addSaving({ amount, date, description = '' }) {
    if (!amount || Number(amount) <= 0) {
      throw new Error('Saving contribution amount must be a positive number.');
    }
    if (!date) {
      throw new Error('Saving contribution date is required.');
    }

    const data = this.getData();
    const newSaving = {
      id: generateId('sav'),
      type: 'saving',
      amount: round2(amount),
      date,
      description: description.trim(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    data.deletedSavingIds = Array.isArray(data.deletedSavingIds) ? data.deletedSavingIds : [];
    data.savings.push(newSaving);
    this.saveData(data);
    return newSaving;
  }

  updateSaving(id, { amount, date, description = '' }) {
    if (!amount || Number(amount) <= 0) {
      throw new Error('Saving contribution amount must be a positive number.');
    }
    if (!date) {
      throw new Error('Saving contribution date is required.');
    }

    const data = this.getData();
    const idx = data.savings.findIndex(s => s.id === id);
    if (idx === -1) {
      throw new Error('Saving contribution not found.');
    }
    data.savings[idx] = {
      ...data.savings[idx],
      amount: round2(amount),
      date,
      description: description.trim(),
      updatedAt: Date.now()
    };
    this.saveData(data);
    return data.savings[idx];
  }

  deleteSaving(id) {
    const data = this.getData();
    const initialLen = data.savings.length;
    data.savings = data.savings.filter(s => s.id !== id);
    if (data.savings.length !== initialLen) {
      data.deletedSavingIds = Array.isArray(data.deletedSavingIds) ? data.deletedSavingIds : [];
      if (!data.deletedSavingIds.includes(id)) data.deletedSavingIds.push(id);
      this.saveData(data);
      return true;
    }
    return false;
  }

  deleteAllLocalData() {
    const current = this.getData();
    // Preserves appearance and currency preferences
    const preservedTheme = current.settings?.theme || 'system';
    const preservedBackground = current.settings?.backgroundPreset || 'default';
    const preservedCurrency = current.settings?.currency || 'USD';

    const fresh = {
      version: 1,
      settings: {
        dailyBudget: null,
        theme: preservedTheme,
        backgroundPreset: preservedBackground,
        currency: preservedCurrency
      },
      // This is a local-cache reset, not an account-wide deletion. A zero
      // timestamp lets an existing cloud copy keep its newer settings when
      // the user next signs in.
      settingsUpdatedAt: 0,
      expenses: [],
      savings: [],
      // Tombstones are only for deliberate, single-record deletes. Clearing
      // the active slot — guest or account — must never manufacture
      // tombstones that could later be treated as cloud deletions.
      deletedExpenseIds: [],
      deletedSavingIds: []
    };
    this.saveData(fresh);
    return fresh;
  }
}

export const store = new Store();

/** Resets storage-slot state for isolated automated tests. */
export function resetStoreForTesting() {
  memoryStorage = new Map();
  activeStorageKey = STORAGE_KEY;
}
