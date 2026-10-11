import { store } from './store.js';
import { FIXED_CATEGORIES } from './config.js';
import {
  getTodayDateString,
  getCurrentYearMonthString,
  getCurrentYearString,
  getRemainingDailyBudget,
  formatCurrency,
  round2,
  setDefaultCurrency,
  getPeriodSummary,
  getPreviousPeriodKey,
  getNextPeriodKey
} from './calculations.js';
import {
  renderDashboard,
  renderMonthlyHistory,
  renderSavings,
  renderSettings,
  escapeHtml
} from './ui.js';
import { answerFinancialQuery, SUPPORTED_QUESTIONS } from './query-engine.js';
import {
  getWallpaper,
  saveWallpaper,
  deleteWallpaper,
  validateWallpaperFile
} from './wallpaper-db.js';
import {
  exportExpenseChartPNG,
  formatPeriodLabel
} from './chart-export.js';
import {
  initAuth,
  subscribeAuth,
  getAuthState,
  signInWithGoogle,
  signOut
} from './auth.js';
import { setupKeyboardShortcuts } from './shortcuts.js';
import { initCloudSync, subscribeCloudSync, syncNow, getCloudSyncState } from './cloud-sync.js';

let currentView = 'dashboard';
let editingExpenseId = null;
let editingSavingId = null;
let confirmCallback = null;

let analyticsState = {
  periodType: 'month',
  periodKey: getCurrentYearMonthString(),
  viewMode: 'total'
};

let currentWallpaperUrl = null;
let hasCustomWallpaper = false;

// Initialize App
export function initApp() {
  const initialSettings = store.getSettings();
  setDefaultCurrency(initialSettings.currency || 'USD');
  applyAppearance(initialSettings);
  applyCurrencyLabels(initialSettings.currency || 'USD');
  setupNavigation();
  setupModals();
  setupAskFinancialMemory();
  setupFirstVisitPrompt();
  initWallpaper();

  // Reactive store subscription
  store.subscribe(data => {
    setDefaultCurrency(data.settings.currency || 'USD');
    applyAppearance(data.settings);
    applyCurrencyLabels(data.settings.currency || 'USD');
    renderCurrentView();
  });

  // Reactive auth subscription
  subscribeAuth(authState => {
    updateSidebarAuthBadge(authState);
    if (currentView === 'settings') {
      renderCurrentView();
    }
  });

  // Keep the account panel updated as sync status changes.
  subscribeCloudSync(() => {
    if (currentView === 'settings') renderCurrentView();
  });

  // Start cloud sync listeners before restoring the Supabase session.
  initCloudSync();

  // Initialize Supabase Auth session & listener
  initAuth();

  renderCurrentView();
}

function updateSidebarAuthBadge(authState) {
  const indicator = document.getElementById('sidebar-auth-indicator');
  const label = document.getElementById('sidebar-auth-label');
  if (!indicator || !label) return;

  if (authState?.user) {
    indicator.style.backgroundColor = 'var(--success)';
    const name = authState.user.user_metadata?.full_name || authState.user.email || 'Signed In';
    label.textContent = name.length > 14 ? `${name.slice(0, 12)}…` : name;
    label.title = authState.user.email || 'Signed In';
  } else {
    indicator.style.backgroundColor = 'var(--text-muted)';
    label.textContent = 'Guest Mode';
    label.title = 'Guest Mode — Local only';
  }
}

async function initWallpaper() {
  try {
    const blob = await getWallpaper();
    if (blob) {
      if (currentWallpaperUrl) {
        URL.revokeObjectURL(currentWallpaperUrl);
      }
      currentWallpaperUrl = URL.createObjectURL(blob);
      hasCustomWallpaper = true;
      applyWallpaperStyle(currentWallpaperUrl);
    } else {
      hasCustomWallpaper = false;
      clearWallpaperStyle();
    }
  } catch (err) {
    console.warn('Failed to load wallpaper:', err);
    hasCustomWallpaper = false;
    clearWallpaperStyle();
  }
}

function applyWallpaperStyle(url) {
  if (typeof document === 'undefined') return;
  document.body.classList.add('has-custom-wallpaper');
  document.body.style.setProperty('--custom-wallpaper', `url("${url}")`);
}

function clearWallpaperStyle() {
  if (typeof document === 'undefined') return;
  if (currentWallpaperUrl) {
    URL.revokeObjectURL(currentWallpaperUrl);
    currentWallpaperUrl = null;
  }
  hasCustomWallpaper = false;
  document.body.classList.remove('has-custom-wallpaper');
  document.body.style.removeProperty('--custom-wallpaper');
}

function applyAppearance(settings) {
  const root = document.documentElement;
  root.setAttribute('data-theme', settings.theme || 'system');
  root.setAttribute('data-preset', settings.backgroundPreset || 'default');
}

function applyCurrencyLabels(currency = 'USD') {
  const expLabel = document.getElementById('label-expense-amount');
  if (expLabel) expLabel.textContent = `Amount (${currency}) *`;
  const savLabel = document.getElementById('label-saving-amount');
  if (savLabel) savLabel.textContent = `Amount (${currency}) *`;
  const firstRunLabel = document.getElementById('label-first-run-budget');
  if (firstRunLabel) firstRunLabel.textContent = `Daily Spending Target (${currency})`;
  const firstRunDesc = document.getElementById('first-run-desc');
  if (firstRunDesc) {
    firstRunDesc.textContent = `Would you like to set an optional daily spending target in ${currency}? This gives you an everyday reference point on your Dashboard. You can also skip this now and configure it later in Settings.`;
  }
}

function setupNavigation() {
  const navButtons = document.querySelectorAll('.nav-button');
  const mobileToggle = document.getElementById('mobile-menu-toggle');
  const sidebar = document.getElementById('sidebar');

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-view');
      navigateTo(target);
      sidebar.classList.remove('mobile-open');
    });
  });

  const sidebarAccountBtn = document.getElementById('sidebar-account-btn');
  if (sidebarAccountBtn) {
    sidebarAccountBtn.addEventListener('click', () => {
      navigateTo('settings');
      sidebar.classList.remove('mobile-open');
    });
  }

  if (mobileToggle) {
    mobileToggle.addEventListener('click', () => {
      sidebar.classList.toggle('mobile-open');
    });
  }
}

export function navigateTo(viewName) {
  currentView = viewName;
  document.querySelectorAll('.nav-button').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === viewName);
  });
  renderCurrentView();
  window.scrollTo(0, 0);
}

function renderCurrentView() {
  const container = document.getElementById('view-container');
  if (!container) return;

  const data = store.getData();

  switch (currentView) {
    case 'dashboard':
      container.innerHTML = renderDashboard(data, navigateTo, analyticsState);
      bindDashboardEvents();
      break;
    case 'monthly-history':
      container.innerHTML = renderMonthlyHistory(data);
      bindMonthlyHistoryEvents();
      break;
    case 'savings':
      container.innerHTML = renderSavings(data);
      bindSavingsEvents();
      break;
    case 'settings':
      container.innerHTML = renderSettings(data, hasCustomWallpaper, currentWallpaperUrl, getAuthState(), getCloudSyncState());
      bindSettingsEvents();
      break;
    default:
      container.innerHTML = renderDashboard(data, navigateTo, analyticsState);
      bindDashboardEvents();
  }
}

function bindDashboardEvents() {
  const btnAdd = document.getElementById('btn-open-add-expense');
  if (btnAdd) btnAdd.addEventListener('click', () => openExpenseModal());

  const btnHistory = document.getElementById('btn-view-month-history');
  if (btnHistory) btnHistory.addEventListener('click', () => navigateTo('monthly-history'));

  const btnQuickBudget = document.getElementById('btn-quick-set-budget');
  if (btnQuickBudget) btnQuickBudget.addEventListener('click', () => navigateTo('settings'));

  // Analytics Period Selector
  const periodSelect = document.getElementById('analytics-period-select');
  if (periodSelect) {
    periodSelect.addEventListener('change', (e) => {
      analyticsState.periodType = e.target.value;
      if (analyticsState.periodType === 'day') {
        analyticsState.periodKey = getTodayDateString();
      } else if (analyticsState.periodType === 'year') {
        analyticsState.periodKey = getCurrentYearString();
      } else {
        analyticsState.periodKey = getCurrentYearMonthString();
      }
      renderCurrentView();
    });
  }

  // Total Spending vs Historical Comparison Mode Toggle
  const btnTotal = document.getElementById('btn-analytics-total');
  if (btnTotal) {
    btnTotal.addEventListener('click', () => {
      analyticsState.viewMode = 'total';
      renderCurrentView();
    });
  }

  const btnCompare = document.getElementById('btn-analytics-compare');
  if (btnCompare) {
    btnCompare.addEventListener('click', () => {
      analyticsState.viewMode = 'compare';
      renderCurrentView();
    });
  }

  // Navigation: Previous, Next, and Current
  const btnPrev = document.getElementById('btn-period-prev');
  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      analyticsState.periodKey = getPreviousPeriodKey(analyticsState.periodType, analyticsState.periodKey);
      renderCurrentView();
    });
  }

  const btnNext = document.getElementById('btn-period-next');
  if (btnNext) {
    btnNext.addEventListener('click', () => {
      analyticsState.periodKey = getNextPeriodKey(analyticsState.periodType, analyticsState.periodKey);
      renderCurrentView();
    });
  }

  const btnToday = document.getElementById('btn-period-today');
  if (btnToday) {
    btnToday.addEventListener('click', () => {
      if (analyticsState.periodType === 'day') {
        analyticsState.periodKey = getTodayDateString();
      } else if (analyticsState.periodType === 'year') {
        analyticsState.periodKey = getCurrentYearString();
      } else {
        analyticsState.periodKey = getCurrentYearMonthString();
      }
      renderCurrentView();
    });
  }

  // Direct Date Pickers
  const dateInput = document.getElementById('analytics-date-input');
  if (dateInput) {
    dateInput.addEventListener('change', (e) => {
      if (e.target.value) {
        analyticsState.periodKey = e.target.value;
        renderCurrentView();
      }
    });
  }

  const monthInput = document.getElementById('analytics-month-input');
  if (monthInput) {
    monthInput.addEventListener('change', (e) => {
      if (e.target.value) {
        analyticsState.periodKey = e.target.value;
        renderCurrentView();
      }
    });
  }

  const yearSelect = document.getElementById('analytics-year-select');
  if (yearSelect) {
    yearSelect.addEventListener('change', (e) => {
      if (e.target.value) {
        analyticsState.periodKey = e.target.value;
        renderCurrentView();
      }
    });
  }

  // Export Chart
  const btnExport = document.getElementById('btn-open-export');
  if (btnExport) {
    btnExport.addEventListener('click', () => {
      openExportChartModal(analyticsState.periodType, analyticsState.periodKey);
    });
  }
}

function bindMonthlyHistoryEvents() {
  const btnAdd = document.getElementById('btn-open-add-expense');
  if (btnAdd) btnAdd.addEventListener('click', () => openExpenseModal());

  const btnFirst = document.getElementById('btn-add-first-expense');
  if (btnFirst) btnFirst.addEventListener('click', () => openExpenseModal());

  document.querySelectorAll('.btn-edit-exp').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const exp = store.getExpenses().find(e => e.id === id);
      if (exp) openExpenseModal(exp);
    });
  });

  document.querySelectorAll('.btn-del-exp').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const exp = store.getExpenses().find(e => e.id === id);
      if (exp) {
        showConfirmation(
          'Delete Expense',
          `Are you sure you want to delete this ${formatCurrency(exp.amount)} (${exp.category}) expense?`,
          () => {
            store.deleteExpense(id);
            showToast('Expense deleted and totals recalculated.');
          }
        );
      }
    });
  });
}

function bindSavingsEvents() {
  const btnAdd = document.getElementById('btn-open-add-saving');
  if (btnAdd) btnAdd.addEventListener('click', () => openSavingModal());

  const btnFirst = document.getElementById('btn-add-first-saving');
  if (btnFirst) btnFirst.addEventListener('click', () => openSavingModal());

  document.querySelectorAll('.btn-edit-sav').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const sav = store.getSavings().find(s => s.id === id);
      if (sav) openSavingModal(sav);
    });
  });

  document.querySelectorAll('.btn-del-sav').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const sav = store.getSavings().find(s => s.id === id);
      if (sav) {
        showConfirmation(
          'Delete Saving Contribution',
          `Are you sure you want to delete this ${formatCurrency(sav.amount)} saving contribution?`,
          () => {
            store.deleteSaving(id);
            showToast('Saving contribution deleted and all-time total recalculated.');
          }
        );
      }
    });
  });
}

function bindSettingsEvents() {
  const currencySelect = document.getElementById('settings-currency-select');
  if (currencySelect) {
    currencySelect.addEventListener('change', () => {
      const newCurrency = currencySelect.value;
      store.setCurrency(newCurrency);
      setDefaultCurrency(newCurrency);
      showToast(`Currency updated to ${newCurrency}`);
    });
  }

  const budgetForm = document.getElementById('form-settings-budget');
  const budgetInput = document.getElementById('settings-budget-input');
  const budgetError = document.getElementById('settings-budget-error');
  const btnRemove = document.getElementById('btn-remove-budget');

  if (budgetForm) {
    budgetForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = parseFloat(budgetInput.value);
      if (isNaN(val) || val <= 0) {
        budgetError.style.display = 'block';
        return;
      }
      budgetError.style.display = 'none';
      store.setDailyBudget(val);
      showToast(`Daily budget set to ${formatCurrency(val)}`);
    });
  }

  if (btnRemove) {
    btnRemove.addEventListener('click', () => {
      store.setDailyBudget(null);
      showToast('Daily budget target removed.');
    });
  }

  const themeSelect = document.getElementById('settings-theme-select');
  if (themeSelect) {
    themeSelect.addEventListener('change', () => {
      store.setTheme(themeSelect.value);
      showToast(`Theme updated to ${themeSelect.value}`);
    });
  }

  const presetSelect = document.getElementById('settings-preset-select');
  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      store.setBackgroundPreset(presetSelect.value);
      showToast(`Background preset updated to ${presetSelect.value}`);
    });
  }

  const btnDeleteAll = document.getElementById('btn-trigger-delete-all');
  if (btnDeleteAll) {
    btnDeleteAll.addEventListener('click', () => {
      showConfirmation(
        'Delete All Local Data',
        'Permanently delete all locally stored expenses, saving contributions, and daily budget targets? This cannot be undone.',
        () => {
          store.deleteAllLocalData();
          showToast('All local data cleared. Preferences preserved.');
          navigateTo('dashboard');
        }
      );
    });
  }

  // Wallpaper Controls
  const btnChooseWallpaper = document.getElementById('btn-choose-wallpaper');
  const wallpaperInput = document.getElementById('wallpaper-file-input');
  const btnRemoveWallpaper = document.getElementById('btn-remove-wallpaper');
  const wallpaperError = document.getElementById('wallpaper-error');
  const previewContainer = document.getElementById('wallpaper-preview-container');
  const previewImg = document.getElementById('wallpaper-preview-img');

  if (btnChooseWallpaper && wallpaperInput) {
    btnChooseWallpaper.addEventListener('click', () => {
      wallpaperInput.click();
    });
  }

  if (wallpaperInput) {
    wallpaperInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const validation = validateWallpaperFile(file);
      if (!validation.valid) {
        if (wallpaperError) {
          wallpaperError.textContent = validation.error;
          wallpaperError.style.display = 'block';
        }
        wallpaperInput.value = '';
        return;
      }

      if (wallpaperError) {
        wallpaperError.style.display = 'none';
      }

      try {
        await saveWallpaper(file);
        if (currentWallpaperUrl) {
          URL.revokeObjectURL(currentWallpaperUrl);
        }
        currentWallpaperUrl = URL.createObjectURL(file);
        hasCustomWallpaper = true;
        applyWallpaperStyle(currentWallpaperUrl);

        if (previewImg) previewImg.src = currentWallpaperUrl;
        if (previewContainer) previewContainer.style.display = 'block';
        if (btnRemoveWallpaper) btnRemoveWallpaper.style.display = 'inline-block';

        showToast('Wallpaper applied successfully.');
      } catch (err) {
        console.error('Failed to save wallpaper:', err);
        if (wallpaperError) {
          wallpaperError.textContent = 'Failed to save wallpaper image locally.';
          wallpaperError.style.display = 'block';
        }
      }
      wallpaperInput.value = '';
    });
  }

  if (btnRemoveWallpaper) {
    btnRemoveWallpaper.addEventListener('click', async () => {
      try {
        await deleteWallpaper();
        clearWallpaperStyle();
        if (previewContainer) previewContainer.style.display = 'none';
        if (previewImg) previewImg.src = '';
        btnRemoveWallpaper.style.display = 'none';
        showToast('Wallpaper removed. Default background restored.');
      } catch (err) {
        console.error('Failed to remove wallpaper:', err);
      }
    });
  }

  // Account / Authentication Controls
  const btnGoogleSignIn = document.getElementById('btn-google-signin');
  if (btnGoogleSignIn) {
    btnGoogleSignIn.addEventListener('click', async () => {
      btnGoogleSignIn.disabled = true;
      btnGoogleSignIn.textContent = 'Connecting...';
      const result = await signInWithGoogle();
      if (result?.error) {
        showToast(`Sign in notice: ${result.error.message || result.error}`);
        btnGoogleSignIn.disabled = false;
        renderCurrentView();
      }
    });
  }

  const btnSignOut = document.getElementById('btn-auth-signout');
  if (btnSignOut) {
    btnSignOut.addEventListener('click', async () => {
      btnSignOut.disabled = true;
      btnSignOut.textContent = 'Signing out...';
      await signOut();
      showToast('Signed out. Application is now in Guest mode.');
      renderCurrentView();
    });
  }

  const btnSyncNow = document.getElementById('btn-cloud-sync-now');
  if (btnSyncNow) {
    btnSyncNow.addEventListener('click', async () => {
      btnSyncNow.disabled = true;
      btnSyncNow.textContent = 'Syncing…';
      const ok = await syncNow();
      const state = getCloudSyncState();
      showToast(ok ? 'Cloud sync completed.' : (state.error || 'Cloud sync failed. Local data is still available.'));
      renderCurrentView();
    });
  }
}

// Modal Handlers
function setupModals() {
  // Populate category options in expense modal
  const catSelect = document.getElementById('expense-category');
  if (catSelect) {
    catSelect.innerHTML = FIXED_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('');
  }

  // Expense Form Submit
  const expenseForm = document.getElementById('form-expense');
  if (expenseForm) {
    expenseForm.addEventListener('submit', handleExpenseSubmit);
  }

  // Saving Form Submit
  const savingForm = document.getElementById('form-saving');
  if (savingForm) {
    savingForm.addEventListener('submit', handleSavingSubmit);
  }

  // Close buttons
  document.querySelectorAll('.modal-close, .btn-modal-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      closeAllModals();
    });
  });

  // Setup Export Chart Modal
  setupExportModal();

  // Confirmation Modal
  const confirmOk = document.getElementById('btn-confirm-ok');
  if (confirmOk) {
    confirmOk.addEventListener('click', () => {
      if (confirmCallback) {
        confirmCallback();
        confirmCallback = null;
      }
      closeAllModals();
    });
  }

  // Keyboard Shortcuts for quick entry ('E' for Expense, 'S' for Savings, 'Escape' to close)
  setupKeyboardShortcuts({
    openExpense: () => openExpenseModal(),
    openSaving: () => openSavingModal(),
    closeModals: () => {
      const activeOverlays = document.querySelectorAll('.modal-overlay.active');
      if (activeOverlays.length > 0) {
        closeAllModals();
        return true;
      }
      return false;
    },
    isAnyModalOpen: () => {
      return document.querySelectorAll('.modal-overlay.active').length > 0;
    }
  });
}

function openExpenseModal(existing = null) {
  editingExpenseId = existing ? existing.id : null;
  applyCurrencyLabels(store.getSettings().currency || 'USD');
  const title = document.getElementById('modal-expense-title');
  const amountInput = document.getElementById('expense-amount');
  const catSelect = document.getElementById('expense-category');
  const dateInput = document.getElementById('expense-date');
  const descInput = document.getElementById('expense-desc');
  const errDiv = document.getElementById('expense-form-error');

  errDiv.style.display = 'none';

  if (existing) {
    title.textContent = 'Edit Expense';
    amountInput.value = existing.amount;
    catSelect.value = existing.category;
    dateInput.value = existing.date;
    descInput.value = existing.description || '';
  } else {
    title.textContent = 'Add Expense';
    amountInput.value = '';
    catSelect.value = FIXED_CATEGORIES[0];
    dateInput.value = getTodayDateString();
    descInput.value = '';
  }

  document.getElementById('modal-expense').classList.add('active');
  amountInput.focus();
}

function handleExpenseSubmit(e) {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('expense-amount').value);
  const category = document.getElementById('expense-category').value;
  const date = document.getElementById('expense-date').value;
  const description = document.getElementById('expense-desc').value;
  const errDiv = document.getElementById('expense-form-error');

  if (isNaN(amount) || amount <= 0 || !category || !date) {
    errDiv.textContent = 'Please enter a valid positive amount, category, and date.';
    errDiv.style.display = 'block';
    return;
  }

  try {
    if (editingExpenseId) {
      store.updateExpense(editingExpenseId, { amount, category, date, description });
      showToast('Expense updated successfully.');
    } else {
      store.addExpense({ amount, category, date, description });

      // Daily Budget Impact Reminder Toast
      const budgetStatus = getRemainingDailyBudget(store.getExpenses(), store.getSettings().dailyBudget);
      let budgetMsg = '';
      if (budgetStatus.configured) {
        if (budgetStatus.status === 'under') {
          budgetMsg = ` — Remaining daily budget: ${formatCurrency(budgetStatus.remaining)}`;
        } else {
          budgetMsg = ` — Over daily budget by ${formatCurrency(budgetStatus.over)}`;
        }
      }
      showToast(`Expense of ${formatCurrency(amount)} saved${budgetMsg}`);
    }
    closeAllModals();
  } catch (err) {
    errDiv.textContent = err.message;
    errDiv.style.display = 'block';
  }
}

function openSavingModal(existing = null) {
  editingSavingId = existing ? existing.id : null;
  applyCurrencyLabels(store.getSettings().currency || 'USD');
  const title = document.getElementById('modal-saving-title');
  const amountInput = document.getElementById('saving-amount');
  const dateInput = document.getElementById('saving-date');
  const descInput = document.getElementById('saving-desc');
  const errDiv = document.getElementById('saving-form-error');

  errDiv.style.display = 'none';

  if (existing) {
    title.textContent = 'Edit Saving Contribution';
    amountInput.value = existing.amount;
    dateInput.value = existing.date;
    descInput.value = existing.description || '';
  } else {
    title.textContent = 'Add Saving Contribution';
    amountInput.value = '';
    dateInput.value = getTodayDateString();
    descInput.value = '';
  }

  document.getElementById('modal-saving').classList.add('active');
  amountInput.focus();
}

function handleSavingSubmit(e) {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('saving-amount').value);
  const date = document.getElementById('saving-date').value;
  const description = document.getElementById('saving-desc').value;
  const errDiv = document.getElementById('saving-form-error');

  if (isNaN(amount) || amount <= 0 || !date) {
    errDiv.textContent = 'Please enter a valid positive amount and date.';
    errDiv.style.display = 'block';
    return;
  }

  try {
    if (editingSavingId) {
      store.updateSaving(editingSavingId, { amount, date, description });
      showToast('Saving contribution updated.');
    } else {
      store.addSaving({ amount, date, description });
      showToast(`Saving contribution of ${formatCurrency(amount)} recorded.`);
    }
    closeAllModals();
  } catch (err) {
    errDiv.textContent = err.message;
    errDiv.style.display = 'block';
  }
}

function showConfirmation(title, message, callback) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  confirmCallback = callback;
  document.getElementById('modal-confirm').classList.add('active');
}

function closeAllModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
  editingExpenseId = null;
  editingSavingId = null;
  confirmCallback = null;
}

// Export Chart Modal Logic
function openExportChartModal(initialType = 'month', initialKey = '') {
  const modal = document.getElementById('modal-export-chart');
  if (!modal) return;

  const periodSelect = document.getElementById('export-period-select');
  const dateInput = document.getElementById('export-date-input');
  const monthInput = document.getElementById('export-month-input');
  const yearInput = document.getElementById('export-year-input');

  const type = initialType || 'month';
  if (periodSelect) periodSelect.value = type;

  if (type === 'day' && dateInput) {
    dateInput.value = initialKey || getTodayDateString();
  } else if (type === 'year' && yearInput) {
    yearInput.value = initialKey || getCurrentYearString();
  } else if (monthInput) {
    monthInput.value = initialKey || getCurrentYearMonthString();
  }

  updateExportModalFields();
  modal.classList.add('active');
}

function updateExportModalFields() {
  const periodSelect = document.getElementById('export-period-select');
  if (!periodSelect) return;
  const periodType = periodSelect.value;
  const dayContainer = document.getElementById('export-date-container-day');
  const monthContainer = document.getElementById('export-date-container-month');
  const yearContainer = document.getElementById('export-date-container-year');
  const dateInput = document.getElementById('export-date-input');
  const monthInput = document.getElementById('export-month-input');
  const yearInput = document.getElementById('export-year-input');
  const previewDiv = document.getElementById('export-summary-preview');

  if (dayContainer) dayContainer.style.display = periodType === 'day' ? 'block' : 'none';
  if (monthContainer) monthContainer.style.display = periodType === 'month' ? 'block' : 'none';
  if (yearContainer) yearContainer.style.display = periodType === 'year' ? 'block' : 'none';

  let periodKey = '';
  if (periodType === 'day') {
    if (dateInput && !dateInput.value) dateInput.value = getTodayDateString();
    periodKey = dateInput ? dateInput.value : getTodayDateString();
  } else if (periodType === 'year') {
    if (yearInput && !yearInput.value) yearInput.value = getCurrentYearString();
    periodKey = yearInput ? yearInput.value : getCurrentYearString();
  } else {
    if (monthInput && !monthInput.value) monthInput.value = getCurrentYearMonthString();
    periodKey = monthInput ? monthInput.value : getCurrentYearMonthString();
  }

  const expenses = store.getExpenses();
  const summary = getPeriodSummary(expenses, periodType, periodKey);
  const label = formatPeriodLabel(periodType, periodKey);
  const currency = store.getSettings().currency || 'USD';

  if (previewDiv) {
    previewDiv.innerHTML = `
      <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.25rem;">
        ${escapeHtml(label)}
      </div>
      <div style="color: var(--text-secondary);">
        Total Spending: <strong style="color: var(--accent-primary);">${formatCurrency(summary.totalSpending, currency)}</strong> &nbsp;•&nbsp; ${summary.expenseCount} entries recorded
      </div>
    `;
  }
}

function setupExportModal() {
  const periodSelect = document.getElementById('export-period-select');
  const dateInput = document.getElementById('export-date-input');
  const monthInput = document.getElementById('export-month-input');
  const yearInput = document.getElementById('export-year-input');
  const btnDoExport = document.getElementById('btn-do-export-chart');

  if (periodSelect) {
    periodSelect.addEventListener('change', () => {
      updateExportModalFields();
    });
  }

  if (dateInput) {
    dateInput.addEventListener('change', () => updateExportModalFields());
  }

  if (monthInput) {
    monthInput.addEventListener('change', () => updateExportModalFields());
  }

  if (yearInput) {
    yearInput.addEventListener('input', () => updateExportModalFields());
    yearInput.addEventListener('change', () => updateExportModalFields());
  }

  if (btnDoExport) {
    btnDoExport.addEventListener('click', () => {
      const periodType = document.getElementById('export-period-select').value;
      let periodKey = '';
      if (periodType === 'day') {
        periodKey = document.getElementById('export-date-input').value || getTodayDateString();
      } else if (periodType === 'year') {
        periodKey = document.getElementById('export-year-input').value || getCurrentYearString();
      } else {
        periodKey = document.getElementById('export-month-input').value || getCurrentYearMonthString();
      }

      const expenses = store.getExpenses();
      const currency = store.getSettings().currency || 'USD';
      const success = exportExpenseChartPNG({ expenses, periodType, periodKey, currency });
      if (success) {
        showToast('Chart exported as PNG.');
        closeAllModals();
      } else {
        showToast('Failed to export chart.');
      }
    });
  }
}

// Ask Financial Memory Conversational Surface
function setupAskFinancialMemory() {
  const fab = document.getElementById('fab-ask');
  const modal = document.getElementById('modal-ask');
  const input = document.getElementById('ask-input');
  const chatForm = document.getElementById('chat-form');
  const messagesContainer = document.getElementById('chat-messages');

  if (!fab || !modal) return;

  const conversationHistory = [];

  function initWelcomeMessage() {
    if (conversationHistory.length === 0) {
      conversationHistory.push({
        role: 'assistant',
        text: 'Hello! I can help you explore and verify your recorded spending this month. Ask me a question or tap a suggestion below to get started.',
        suggestions: [
          'Which category has the highest spending this month?',
          'Which day had the highest spending this month?'
        ]
      });
      renderChatMessages();
    }
  }

  fab.addEventListener('click', () => {
    modal.classList.add('active');
    initWelcomeMessage();
    if (input) {
      setTimeout(() => input.focus(), 60);
    }
  });

  if (chatForm) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input ? input.value.trim() : '';
      if (!q) return;
      handleSendMessage(q);
    });
  }

  function handleSendMessage(userQuery) {
    // Append user message
    conversationHistory.push({
      role: 'user',
      text: userQuery
    });

    if (input) {
      input.value = '';
    }
    renderChatMessages();

    // Query existing engine
    const answer = answerFinancialQuery(userQuery, store.getExpenses());
    let responseText = '';
    let evidence = null;
    let explanation = null;
    let canVerify = false;
    let suggestions = [];

    if (answer.status === 'unsupported') {
      responseText = "I don't have enough context to answer that. I can help you explore your recorded spending, though.";
      suggestions = [
        'Which category has the highest spending this month?',
        'Which day had the highest spending this month?'
      ];
    } else if (answer.status === 'no_data') {
      responseText = answer.directAnswer;
      explanation = answer.explanation;
      suggestions = [
        'Which category has the highest spending this month?',
        'Which day had the highest spending this month?'
      ];
    } else {
      // success
      responseText = answer.directAnswer;
      evidence = answer.evidence || null;
      canVerify = Boolean(answer.canVerify);

      // Follow-up suggestions
      if (answer.intent === 'HIGHEST_CATEGORY') {
        suggestions = ['Which day had the highest spending this month?'];
      } else if (answer.intent === 'HIGHEST_DAY') {
        suggestions = ['Which category has the highest spending this month?'];
      } else {
        suggestions = [
          'Which category has the highest spending this month?',
          'Which day had the highest spending this month?'
        ];
      }
    }

    conversationHistory.push({
      role: 'assistant',
      text: responseText,
      evidence,
      explanation,
      canVerify,
      suggestions
    });

    renderChatMessages();
    if (input) {
      input.focus();
    }
  }

  function renderChatMessages() {
    if (!messagesContainer) return;

    messagesContainer.innerHTML = conversationHistory.map(msg => {
      if (msg.role === 'user') {
        return `
          <div class="chat-msg-row user">
            <div class="chat-bubble">
              <div class="chat-msg-content">${escapeHtml(msg.text)}</div>
            </div>
          </div>
        `;
      }

      const evidenceHtml = msg.evidence
        ? `<div class="chat-msg-evidence">${escapeHtml(msg.evidence)}</div>`
        : '';
      const explanationHtml = msg.explanation
        ? `<div class="chat-msg-explanation">${escapeHtml(msg.explanation)}</div>`
        : '';
      const verifyHtml = msg.canVerify
        ? `<div class="chat-verify-action">
            <button type="button" class="btn btn-primary btn-sm btn-chat-verify">
              View Monthly History to Verify
            </button>
           </div>`
        : '';

      const suggestionsHtml = (msg.suggestions && msg.suggestions.length > 0)
        ? `<div class="chat-suggestions-box">
            <div class="chat-suggestions-title">Suggested questions</div>
            ${msg.suggestions.map(s => `
              <button type="button" class="chat-suggestion-chip" data-query="${escapeHtml(s)}">
                ${escapeHtml(s)}
              </button>
            `).join('')}
           </div>`
        : '';

      return `
        <div class="chat-msg-row assistant">
          <div class="chat-bubble">
            <div class="chat-msg-content">${escapeHtml(msg.text)}</div>
            ${evidenceHtml}
            ${explanationHtml}
            ${verifyHtml}
            ${suggestionsHtml}
          </div>
        </div>
      `;
    }).join('');

    // Bind suggestion chips to submit new query
    messagesContainer.querySelectorAll('.chat-suggestion-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const query = chip.getAttribute('data-query');
        if (query) {
          handleSendMessage(query);
        }
      });
    });

    // Bind verify buttons to navigate to monthly history
    messagesContainer.querySelectorAll('.btn-chat-verify').forEach(btn => {
      btn.addEventListener('click', () => {
        closeAllModals();
        navigateTo('monthly-history');
      });
    });

    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

// Optional First Visit Prompt
function setupFirstVisitPrompt() {
  const hasPrompted = localStorage.getItem('financial_memory_prompted_first_run');
  if (hasPrompted) return;

  const currentBudget = store.getSettings().dailyBudget;
  if (currentBudget === null) {
    localStorage.setItem('financial_memory_prompted_first_run', 'true');
    const modal = document.getElementById('modal-first-run');
    if (modal) {
      modal.classList.add('active');

      const form = document.getElementById('form-first-run');
      const skipBtn = document.getElementById('btn-first-run-skip');

      if (form) {
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const val = parseFloat(document.getElementById('first-run-budget-input').value);
          if (!isNaN(val) && val > 0) {
            store.setDailyBudget(val);
            showToast(`Daily budget target set to ${formatCurrency(val)}`);
          }
          modal.classList.remove('active');
        });
      }

      if (skipBtn) {
        skipBtn.addEventListener('click', () => {
          modal.classList.remove('active');
        });
      }
    }
  }
}

// Toast Notifications
export function showToast(message) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3500);
}

// Auto-initialize when loaded directly in browser environment
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initApp());
  } else {
    initApp();
  }
}
