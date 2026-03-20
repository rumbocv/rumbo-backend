// ============================================================
// sessions.js — Supabase session store (48h TTL)
// ============================================================
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TTL_HOURS = 48;

export async function save(id, data) {
  await supabase.from('sessions').insert({ id, data });
}

export async function get(id) {
  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', id)
    .gt('created_at', new Date(Date.now() - TTL_HOURS * 3600 * 1000).toISOString())
    .single();

  return session || null;
}

export async function markPaid(id, tier) {
  const { data } = await supabase
    .from('sessions')
    .update({ paid: true, tier })
    .eq('id', id)
    .select()
    .single();

  return !!data;
}
