import { createClient } from "@supabase/supabase-js";

// Every number in the terminal comes from this Supabase project. The URL and
// anon key are public by design (they ship to the browser in any Supabase
// app): the anon role can only read, row-level security blocks every write,
// and all data is written inside Supabase by the edge functions that pg_cron
// runs (see supabase/functions and supabase/migrations).
//
// NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY override the
// defaults, e.g. to point the app at a copy of the project.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pcvuajgqlfaxdaoijpqi.supabase.co";
export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBjdnVhamdxbGZheGRhb2lqcHFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwMTA3ODcsImV4cCI6MjEwNDU4Njc4N30.hjTk_rMbnHL-bg_b04VvQLPlVyITKJurp9iKl90Yj6A";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 5 } },
});

/** Public URL of one of the project's edge functions. */
export function edgeFunctionUrl(name: string): string {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}
