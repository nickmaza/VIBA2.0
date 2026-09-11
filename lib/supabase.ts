import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// `hasSupabase` lets the UI fall back to bundled demo data (see lib/demo-data.ts)
// when env vars aren't configured yet -- e.g. on first clone, before you've
// pasted in your project's URL/anon key. See README.md "Connect Supabase".
export const hasSupabase = Boolean(url && anonKey);

let client: SupabaseClient | null = null;
if (hasSupabase) {
  client = createClient(url as string, anonKey as string, {
    realtime: { params: { eventsPerSecond: 5 } },
  });
}

export const supabase = client;
