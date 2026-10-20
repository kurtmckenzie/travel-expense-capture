// Supabase connection. The publishable (anon) key is designed to be public: the database
// rules in supabase/schema.sql make sure only a signed-in account can read or write its own data.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://gcpqjtjdlaznscnrkwjb.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_neaoDrykxBfIo0PWHylGaQ_PYER_aI0',
  BUCKET: 'receipts'
};
