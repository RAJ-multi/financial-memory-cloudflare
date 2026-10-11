# Financial Memory

A local-first personal finance tracker for students, with historical spending insights, savings tracking, Google authentication, and optional per-account cloud synchronization.

## Cloudflare Pages deployment

- **Framework preset:** None
- **Build command:** `npm run build`
- **Build output directory:** `dist`
- **Root directory:** leave blank
- **Production branch:** `main`

Set these variables under Cloudflare Pages → Settings → Variables and Secrets for Production (and Preview if you use preview deployments):

- `SUPABASE_URL`: the base Supabase project URL (for example, `https://your-project.supabase.co`; do not append `/rest/v1/`)
- `SUPABASE_ANON_KEY`: your public Supabase publishable/anon key

Never put a Supabase service-role key or database password in frontend code or these public configuration values.

## Enable cloud synchronization

1. Open the Supabase project associated with this deployment.
2. In the Supabase SQL Editor, run the migration at `supabase/migrations/20261011000000_financial_memory_cloud.sql`.
3. Make sure Google authentication is enabled and the app's deployment URLs are allowed in Supabase Authentication → URL Configuration.
4. Deploy the application and sign in with Google. In Settings, check the Cloud sync status or use **Sync now**.

The migration creates `public.financial_memory_cloud` with row-level security. Policies restrict each signed-in user to their own row. The app stores one JSON payload per user, including expenses, savings, settings, record update timestamps, and deletion markers used during merges.

## How sync behaves

- Guest mode continues to use local browser storage.
- On first sign-in, local records are merged with any cloud records for that user.
- After sign-in, updates are sent to Supabase automatically after a short debounce; a manual **Sync now** action is available in Settings.
- Records merge by ID and latest update time; deletion markers help prevent deleted records from reappearing on another device.
- Local data remains available if a sync request fails. Keep backups of important records; cloud sync is not a substitute for a backup strategy.
- Custom wallpaper image blobs stored in IndexedDB are not included in cloud sync.

Run the automated tests with `npm test` and a production build with `npm run build`.
