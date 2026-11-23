/**
 * Sequential document numbers (invoice, receipt, lab request, credit note, GRN).
 * Uses atomic UPDATE … RETURNING on document_sequences.
 */
import { supabase } from '../config/supabase.js';

/**
 * @param {'invoice'|'receipt'|'lab_request'|'credit_note'|'grn'} kind
 * @returns {Promise<string>}
 */
export async function nextDocumentNo(kind) {
  const { data, error } = await supabase.rpc('hms_next_document_no', { p_kind: kind });
  if (!error && data) return String(data);

  // Fallback without RPC: read + update (best-effort; apply migration for RPC if races matter)
  const { data: row, error: readErr } = await supabase
    .from('document_sequences')
    .select('kind, prefix, last_value')
    .eq('kind', kind)
    .maybeSingle();
  if (readErr) throw readErr;

  const prefix = row?.prefix || `${String(kind).toUpperCase()}-`;
  const next = (row?.last_value || 0) + 1;

  if (row) {
    const { error: upErr } = await supabase
      .from('document_sequences')
      .update({ last_value: next, updated_at: new Date().toISOString() })
      .eq('kind', kind)
      .eq('last_value', row.last_value);
    if (upErr) throw upErr;
  } else {
    const { error: insErr } = await supabase.from('document_sequences').insert({
      kind,
      prefix,
      last_value: next,
    });
    if (insErr) throw insErr;
  }

  return `${prefix}${String(next).padStart(5, '0')}`;
}
