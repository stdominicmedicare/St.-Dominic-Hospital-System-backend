/**
 * Shared patient projection for legacy + HMS modules.
 * Identity is always profiles.id; MRN is the shared Patient ID shown in UI.
 */
export const PATIENT_LIST_FIELDS = 'id, mrn, full_name, email, phone';
export const PATIENT_MIN_FIELDS = 'id, mrn, full_name, email';

/**
 * Best-effort encounter write — never fail the primary clinical action.
 */
export async function safeCreateEncounter(createEncounterFn, payload) {
  try {
    return await createEncounterFn(payload);
  } catch (err) {
    console.warn('[encounter]', payload?.module, err?.message || err);
    return null;
  }
}
