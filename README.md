# Padel HQ

Match log, leaderboard and beer ledger for Erki, Taavi, Tõnis and Karl.
A static site (GitHub Pages), with Supabase as the shared database. No build step and no dependencies.

**Rule:** every player on the losing team owes every player on the winning team one beer per match.
Debts are netted between each pair. Either side marks a debt as paid ("I paid" / "Got it").

## Who can do what

| | Player | Admin (Tõnis) |
|---|---|---|
| View everything, log matches | ✓ | ✓ |
| Delete a match | own only | any |
| Mark beers paid | debts you owe or are owed | any |
| Undo a payment | own only | any |
| Reset passwords (signs that player out everywhere) | — | ✓ |

The database enforces these rules (row-level security), not just the buttons.

## Setup (about 15 min)

### 1. Supabase (free tier)
1. Create a project at supabase.com.
2. In **SQL Editor**, run `supabase.sql`, then run `supabase-seed.local.sql`.
   The seed file holds everyone's starting password. It's git-ignored, so **never commit it**.
   After running it, delete that query from the SQL Editor history.
3. From **Project Settings → API**, copy the Project URL and the `anon` public key into `config.js`.

### 2. GitHub Pages
```powershell
git init; git add .; git status   # check: supabase-seed.local.sql must NOT be listed
git commit -m "Padel HQ"
git branch -M main
git remote add origin https://github.com/<you>/padel-hq.git
git push -u origin main
```
Then go to repo **Settings → Pages → Deploy from branch → `main` / root**.
The site will be at `https://<you>.github.io/padel-hq/`.

### 3. Keep the database awake
Supabase pauses idle free projects. To prevent that, add repo secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY`
(**Settings → Secrets and variables → Actions**). `.github/workflows/keepalive.yml` then pings the database twice a week.

### 4. Share
Send each player the link and their own password, privately. Each phone logs in once and stays logged in.
"Add to Home Screen" makes it feel like an app.

## Passwords
- Passwords are funny word combos like `adjective-noun-NN`. They're stored bcrypt-hashed in the database and never appear in the site code.
- Login ignores capitals in names and passwords, and "Tonis" works for "Tõnis".
- 10 wrong guesses lock that player for 15 minutes.
- Forgotten password: the admin opens **Admin → New password** and passes the new one on.

## Adding a player
Add them to `players` in `config.js`, then add a row to the `players` table with a hashed password
(copy the pattern from `supabase-seed.local.sql`).
