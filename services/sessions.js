const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TTL_HOURS = 48;

async function save(id, data, filename = null, storagePath = null, situacion = null, leadEmail = null) {
  const record = { id, data };
  if (filename)    record.filename     = filename;
  if (storagePath) record.storage_path = storagePath;
  if (situacion)   record.situacion    = situacion;
  if (leadEmail)   record.lead_email   = leadEmail;
  const { error } = await supabase.from('sessions').insert(record);
  if (error) {
    console.error('[sessions/save] Error:', error.message, error.details, error.hint);
    throw new Error(`DB save failed: ${error.message}`);
  }
}

async function get(id) {
  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', id)
    .gt('created_at', new Date(Date.now() - TTL_HOURS * 3600 * 1000).toISOString())
    .single();
  return session || null;
}

async function getForCheckout(id) {
  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', id)
    .single();
  return session || null;
}

async function markCheckout(id, tier) {
  await supabase.from('sessions').update({ checkout: true, checkout_tier: tier }).eq('id', id);
}

async function markPaid(id, tier) {
  const { data } = await supabase
    .from('sessions')
    .update({ paid: true, tier })
    .eq('id', id)
    .select()
    .single();
  return !!data;
}

async function saveContact(id, name, email) {
  // Get next order number (max + 1, starting at 205)
  const { data: maxRow } = await supabase
    .from('sessions')
    .select('order_number')
    .not('order_number', 'is', null)
    .order('order_number', { ascending: false })
    .limit(1)
    .single();

  const orderNumber = maxRow?.order_number ? maxRow.order_number + 1 : 205;

  const { error } = await supabase
    .from('sessions')
    .update({ contact_name: name, contact_email: email, order_number: orderNumber })
    .eq('id', id);

  if (error) console.error('[sessions/saveContact] Error:', error.message);
  return error ? null : orderNumber;
}

async function getLeadsForFollowup() {
  // Sessions from 23–25h ago, with lead_email, not paid
  const now = Date.now();
  const from = new Date(now - 25 * 3600 * 1000).toISOString();
  const to   = new Date(now - 23 * 3600 * 1000).toISOString();

  const { data } = await supabase
    .from('sessions')
    .select('id, lead_email, data, followup_sent')
    .gte('created_at', from)
    .lte('created_at', to)
    .eq('paid', false)
    .not('lead_email', 'is', null)
    .eq('followup_sent', false);

  return data || [];
}

async function markFollowupSent(id) {
  await supabase.from('sessions').update({ followup_sent: true }).eq('id', id);
}

module.exports = { save, get, getForCheckout, markPaid, markCheckout, saveContact, getLeadsForFollowup, markFollowupSent };
