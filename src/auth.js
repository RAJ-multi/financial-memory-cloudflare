import { createClient as supabaseCreateClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG } from './supabase-config.js';

let supabaseClient = null;
let currentSession = null;
let currentUser = null;
let authStateListeners = [];
let isAuthLoading = true;
let authError = null;

/**
 * Returns the createClient function: prefers the bundled @supabase/supabase-js
 * package, falling back to window.supabase?.createClient if present.
 */
function getCreateClientFn() {
  if (typeof supabaseCreateClient === 'function') {
    return supabaseCreateClient;
  }
  if (typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function') {
    return window.supabase.createClient;
  }
  return null;
}

/**
 * Resets cached Supabase client and auth session (primarily for automated testing).
 */
export function resetSupabaseClientForTesting() {
  supabaseClient = null;
  currentSession = null;
  currentUser = null;
  authError = null;
}

/**
 * Supplies a fake client to cloud-sync tests without configuring a real
 * Supabase project. It is intentionally test-only and is never used by app
 * initialization.
 */
export function setSupabaseClientForTesting(client) {
  supabaseClient = client;
}

/**
 * Checks whether Supabase is configured with a valid URL and publishable anon key.
 */
export function isSupabaseConfigured() {
  const url = (SUPABASE_CONFIG.url || '').trim();
  const anonKey = (SUPABASE_CONFIG.anonKey || '').trim();
  return Boolean(url && anonKey && url.startsWith('http'));
}

/**
 * Gets or initializes the Supabase client.
 * Returns null if Supabase is not configured or the library is unavailable.
 */
export function getSupabase() {
  if (supabaseClient) return supabaseClient;
  if (!isSupabaseConfigured()) return null;

  const createClientFn = getCreateClientFn();
  if (!createClientFn) {
    return null;
  }

  try {
    supabaseClient = createClientFn(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'financial_memory_auth_token'
      }
    });
    return supabaseClient;
  } catch (err) {
    console.error('Failed to initialize Supabase client:', err);
    authError = err.message || 'Initialization failed';
    return null;
  }
}

/**
 * Subscribes a listener to authentication state updates.
 * Listener receives: { user, session, mode: 'signed_in' | 'guest', isLoading, error, isConfigured }
 */
export function subscribeAuth(listener) {
  authStateListeners.push(listener);
  // Emit immediate current state
  try {
    listener(getAuthState());
  } catch (err) {
    console.error('Error in auth state listener:', err);
  }
  return () => {
    authStateListeners = authStateListeners.filter(l => l !== listener);
  };
}

function notifyAuth() {
  const state = getAuthState();
  for (const listener of authStateListeners) {
    try {
      listener(state);
    } catch (err) {
      console.error('Error in auth state listener:', err);
    }
  }
}

/**
 * Returns the current synchronous authentication state snapshot.
 */
export function getAuthState() {
  const configured = isSupabaseConfigured();
  return {
    user: currentUser,
    session: currentSession,
    mode: currentUser ? 'signed_in' : 'guest',
    isLoading: isAuthLoading,
    error: authError,
    isConfigured: configured
  };
}

/**
 * Initializes the auth service: restores existing session, cleans OAuth hash/query if present,
 * and attaches auth state change listeners.
 */
export async function initAuth() {
  isAuthLoading = true;
  authError = null;

  // Try loading runtime configuration if not already configured
  await SUPABASE_CONFIG.loadRuntimeConfig();

  // Clean URL hash after OAuth redirect if it contains access_token or error
  handleUrlAuthCallback();

  if (!isSupabaseConfigured()) {
    isAuthLoading = false;
    notifyAuth();
    return;
  }

  const client = getSupabase();
  if (!client) {
    isAuthLoading = false;
    notifyAuth();
    return;
  }

  try {
    const { data, error } = await client.auth.getSession();
    if (error) {
      console.warn('Supabase getSession error:', error.message);
      authError = error.message;
      currentSession = null;
      currentUser = null;
    } else {
      currentSession = data.session;
      currentUser = data.session?.user || null;
    }
  } catch (err) {
    console.warn('Error reading session:', err);
    authError = err.message;
    currentSession = null;
    currentUser = null;
  }

  // Subscribe to subsequent auth changes (sign in, sign out, token refresh)
  try {
    client.auth.onAuthStateChange((event, session) => {
      currentSession = session;
      currentUser = session?.user || null;
      authError = null;
      notifyAuth();
    });
  } catch (err) {
    console.warn('Failed to listen to auth state changes:', err);
  }

  isAuthLoading = false;
  notifyAuth();
}

/**
 * Handles OAuth return URL parameters (access_token, refresh_token, error, error_description)
 * so tokens are caught and the URL can be cleaned for a smooth user experience.
 */
function handleUrlAuthCallback() {
  if (typeof window === 'undefined' || !window.location) return;

  const url = new URL(window.location.href);
  const hash = url.hash;
  const searchParams = url.searchParams;

  // Check for error parameters in search or hash
  if (searchParams.has('error') || searchParams.has('error_description')) {
    authError = searchParams.get('error_description') || searchParams.get('error');
    cleanAuthUrl();
    return;
  }

  if (hash.includes('error=')) {
    const hashParams = new URLSearchParams(hash.replace(/^#/, ''));
    authError = hashParams.get('error_description') || hashParams.get('error');
    cleanAuthUrl();
    return;
  }

  // If there's an OAuth access_token or code, Supabase client automatically processes it.
  // We clean up URL fragment cleanly after a short tick once detected.
  if (hash.includes('access_token=') || searchParams.has('code')) {
    setTimeout(() => {
      cleanAuthUrl();
    }, 100);
  }
}

function cleanAuthUrl() {
  if (typeof window === 'undefined' || !window.history || !window.location) return;
  const cleanUrl = window.location.origin + window.location.pathname;
  window.history.replaceState(null, '', cleanUrl);
}

/**
 * Initiates Google OAuth sign-in flow via Supabase.
 */
export async function signInWithGoogle() {
  authError = null;

  if (!isSupabaseConfigured()) {
    authError = 'Supabase URL or public anon key is not configured yet.';
    notifyAuth();
    return { error: new Error(authError) };
  }

  const client = getSupabase();
  if (!client) {
    authError = 'Supabase client library is unavailable.';
    notifyAuth();
    return { error: new Error(authError) };
  }

  try {
    const redirectTo = SUPABASE_CONFIG.getRedirectUrl();
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectTo || undefined,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent'
        }
      }
    });

    if (error) {
      authError = error.message;
      notifyAuth();
      return { error };
    }

    return { data };
  } catch (err) {
    authError = err.message || 'Failed to start Google sign-in';
    notifyAuth();
    return { error: err };
  }
}

/**
 * Signs the user out from Supabase Auth and returns the application to Guest mode.
 * This function itself never mutates stored datasets: the cloud-sync lifecycle
 * reacts to the auth update by hiding the account cache and selecting a clean
 * guest session. The account's cloud copy is never deleted by signing out.
 */
export async function signOut() {
  authError = null;

  const client = getSupabase();
  // Move the application to guest mode before waiting for a network round
  // trip. The Supabase client still holds the token needed to finish its own
  // sign-out request, while subscribers can immediately swap away from the
  // authenticated account's data. The account's cloud copy is never deleted
  // by signing out.
  currentSession = null;
  currentUser = null;
  notifyAuth();

  if (!client) {
    return;
  }

  try {
    const { error } = await client.auth.signOut();
    if (error) {
      console.warn('Sign out warning:', error.message);
    }
  } catch (err) {
    console.warn('Error during sign out:', err);
  }
}
