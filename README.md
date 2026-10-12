# Padel HQ

Match log, leaderboard and beer ledger for Erki, Taavi, Tõnis and Karl.
A static site (GitHub Pages), with Supabase as the shared database. No build step and no dependencies.

**Rule:** every player on the losing team owes every player on the winning team one beer per match.
In Americano, that applies per round. Debts are netted between each pair. Either side can mark beers as paid
("I paid" / "Got it"), all at once or a few at a time.

## Game types
- **Regular:** pick the teams and enter up to 3 sets.
- **Americano:** log a whole training in one go. You start with 3 rounds (one full rotation). **+ Add round** continues the rotation,
  tapping the team names changes a round's pairing, and × removes a round. Draws aren't allowed; play one more point.
  The rounds show as one card with each player's points total, and Delete removes the whole session.
- **Guest:** when someone stands in for one of you, pick the **Guest** chip (Americano: under "Who played?").
  An optional name shows as e.g. "Mart (guest)". Guests aren't on the leaderboard and never owe or receive beers.
  Their partner's win or loss still counts as normal.
- On the leaderboard, filter by All / Regular / Americano. Regular counts games and Americano counts points; the two are tracked separately.

## Who can do what

| | Player | Admin (Tõnis) |
|---|---|---|
| View everything, log matches | ✓ | ✓ |
| Delete a match | — | ✓ |
| Mark beers paid (all or part) | debts you owe or are owed | any |
| Undo a payment | own only | any |
| Change own password (tap your name) | ✓ | ✓ |
| Reset someone's password (signs them out everywhere) | — | ✓ |

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
- Starting passwords are temporary funny word combos like `adjective-noun-NN`. **On first login, everyone must pick their own password.**
- Later, tap your name in the top right to change your password. Changing it signs out your other devices.
- Passwords are stored bcrypt-hashed in the database and never appear in the site code.
- Names and passwords are not case-sensitive, and "Tonis" works for "Tõnis". Minimum length is 6 characters.
- 10 wrong guesses lock that player for 15 minutes.
- Forgotten password: the admin opens **Admin → New password**. That player gets a new temporary password and must pick their own again at next login.
- Already ran an older `supabase.sql`? Just run the new one again. It's safe to re-run, and it adds the new columns and functions.

## Adding a player
Add them to `players` in `config.js`, then add a row to the `players` table with a hashed password
(copy the pattern from `supabase-seed.local.sql`).
