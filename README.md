# Travel Expenses

An offline-first iPhone web app (PWA) for capturing travel receipts: photo, date, amount, currency, category, trip/project code, purpose and payment method. Everything saves on the phone first, then backs up to your own Supabase project when you have signal. When you are back at a computer, tick the receipts you want and download a ZIP (renamed images plus a CSV) to key into Oracle iExpense.

## One-time setup (about 15 minutes)

### 1. Create the Supabase project
1. At supabase.com create a new project (any name, pick the closest region).
2. Open **SQL Editor -> New query**, paste all of `supabase/schema.sql`, and click **Run**. This creates the `expenses` table and a **private** `receipts` bucket, locked so each signed-in user sees only their own data.
3. Open **Project Settings -> API** and copy the **Project URL** and the **anon / publishable key**.
4. Paste them into `config.js` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`). The anon key is meant to be public; the database rules protect your data.

### 2. Create a GitHub OAuth app for sign-in
1. On GitHub: **Settings -> Developer settings -> OAuth Apps -> New OAuth App**.
2. Homepage URL: `https://kurtmckenzie.github.io/travel-expense-capture/`
3. Authorization callback URL: `https://<your-project-ref>.supabase.co/auth/v1/callback` (shown in Supabase under **Authentication -> Providers -> GitHub**).
4. Create it, generate a **client secret**, then in Supabase **Authentication -> Providers -> GitHub** enable the provider and paste the **Client ID** and **Client secret**.
5. In Supabase **Authentication -> URL Configuration** set **Site URL** to `https://kurtmckenzie.github.io/travel-expense-capture/` and add the same address under **Redirect URLs**.

### 3. Publish on GitHub Pages
```bash
cd travel-expense-capture
git init -b main
git add .
git commit -m "Travel expense capture app"
gh repo create travel-expense-capture --public --source . --push
```
Then in the repo: **Settings -> Pages -> Build and deployment -> Deploy from a branch -> main / (root)**. After a minute the app is live at `https://kurtmckenzie.github.io/travel-expense-capture/`.

The repo can be public: it contains no secrets. (Private repos need a paid GitHub plan for Pages.)

### 4. Lock it to you
1. Open the app, go to **Settings**, tap **Sign in with GitHub**, and approve.
2. In Supabase **Authentication -> Sign In / Providers**, turn **off "Allow new users to sign up"**. After that nobody else can create an account on your project, even though the app address is public.

### 5. Install on your iPhone
1. Open the address in **Safari** (it must be Safari for installing).
2. Tap **Share -> Add to Home Screen**.
3. Open it from the Home Screen icon, sign in once while online, and allow the camera when asked.

Before a trip, open the app once on Wi-Fi so it caches itself, then try Airplane mode to confirm it opens.

## Using it
- **Capture:** Take photo (or pick from library), fill in amount, category, purpose; the date, trip, currency and payment method remember your last choice. Save.
- **Expenses:** grouped by trip with totals. Tap a thumbnail to see the receipt, Edit or Delete as needed. A "not backed up" badge means it is only on the phone so far.
- **Export when you return:** filter by trip, tick the receipts you need (or Select all), then **Download ZIP**. The ZIP has `receipts/` with files named like `2026-10-19_Food-Lunch_USD45.20.jpg` and an `expenses.csv` listing each row with its image file names. **Mark exported** keeps track of what you have already entered in iExpense.
- **Settings:** edit the category, currency and payment lists.

## Notes and limits
- iPhone Safari may clear a web app's storage if it is unused for about seven days and not installed. Installing to the Home Screen and signing in so photos back up avoids this. Back up before relying on it for a long trip.
- If the app shows a new version is not appearing, close it fully and reopen it online once. When changing app files, increase `VERSION` in `sw.js`.
- Photos are resized to at most 2000 px and saved as JPEG (roughly 200-500 KB each).
- Amounts and currencies are stored exactly as entered; no conversion is done.
