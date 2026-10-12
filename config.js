// Edit this file, commit, push. That's the whole admin panel.
window.PADEL_CONFIG = {
  clubName: "Padel HQ",

  // Supabase project (Settings → API). The anon key is meant to be public:
  // all data access needs a logged-in session (see supabase.sql).
  supabaseUrl: "https://pjlmxhtpnyecireyhvbr.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBqbG14aHRwbnllY2lyZXlodmJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4MDAyMzEsImV4cCI6MjEwNzM3NjIzMX0.rQmS_hNFmI6iMU8ZrW3puG6GB3q3_rGvqjBPSzlnkO8",

  // Each player on the losing team owes each player on the winning team this many beers.
  beersPerLoss: 1,

  // Keep `id` stable forever — matches reference it. Name can change any time.
  // Login = name (case and õ/o don't matter) + password. Passwords and admin rights live
  // in the database (supabase-seed.local.sql), never here — this file is public.
  players: [
    { id: "erki",  name: "Erki" },
    { id: "taavi", name: "Taavi" },
    { id: "tonis", name: "Tõnis" },
    { id: "karl",  name: "Karl" },
  ],
};
