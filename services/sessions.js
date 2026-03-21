const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TTL_HOURS = 48;

async function save(id, data, filename = null) {
  const record = { id, data };
  if (filename) record.filename = filename;
  const { error } = await supabase.from('sessions').insert(record);
  if (error) console.error('[sessions/save] Error:', error.message, error.details);
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

module.exports = { save, get, markPaid, saveContact };
