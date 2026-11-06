/**
 * St Dominic HMS — role mapping + portal permission matrix.
 *
 * Clinical staff is split into Clerk · Nurse · Doctor (HTML OPD users).
 * Access levels: 'none' | 'view' | 'edit' | 'full'
 * 'none' = hidden from menu AND blocked by API (403).
 */

export const HMS_ROLES = {
  Administrator: 'Administrator',
  Clerk: 'Clerk',
  Nurse: 'Nurse',
  Doctor: 'Doctor',
  Midwife: 'Midwife',
  Laboratory: 'Laboratory',
  Pharmacy: 'Pharmacy',
  Accounts: 'Accounts',
};

/** Map fine-grained app_role → HMS label (null = non-HMS legacy portal). */
export const APP_ROLE_TO_HMS = {
  Admin: HMS_ROLES.Administrator,
  Clerk: HMS_ROLES.Clerk,
  // Legacy aliases until profiles migrated
  Receptionist: HMS_ROLES.Clerk,
  RecordsOfficer: HMS_ROLES.Clerk,
  Nurse: HMS_ROLES.Nurse,
  Doctor: HMS_ROLES.Doctor,
  Midwife: HMS_ROLES.Midwife,
  Laboratory: HMS_ROLES.Laboratory,
  Pharmacy: HMS_ROLES.Pharmacy,
  Accounts: HMS_ROLES.Accounts,
  Patient: null,
  Ambulance: null,
  ICU: null,
  BloodBank: null,
  'Blood Bank': null,
  Volunteer: null,
  GeneralUser: null,
};

export const PERMISSION_FLAGS = {
  HIV: 'can_access_hiv',
  VERIFY_LAB: 'can_verify_lab',
  DISCOUNTS: 'can_give_discounts',
  EXPORT: 'can_export_reports',
};

/**
 * OPD workflow actions (HTML: clerk check-in, nurse triage, doctor consult).
 * Admin always allowed.
 */
export const OPD_ACTIONS = {
  check_in: ['Admin', 'Clerk', 'Receptionist', 'RecordsOfficer', 'Nurse', 'Doctor'],
  triage: ['Admin', 'Nurse', 'Doctor'],
  consult: ['Admin', 'Doctor'],
};

export function canOpdAction(appRole, action) {
  if (!appRole || !action) return false;
  if (appRole === 'Admin' || toHmsRole(appRole) === HMS_ROLES.Administrator) return true;
  const allowed = OPD_ACTIONS[action];
  if (!allowed) return false;
  return allowed.includes(appRole);
}

/**
 * Portal keys used by menu + requirePortal middleware.
 */
export const PORTAL_MATRIX = {
  home: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'full',
    [HMS_ROLES.Nurse]: 'full',
    [HMS_ROLES.Doctor]: 'full',
    [HMS_ROLES.Midwife]: 'full',
    [HMS_ROLES.Laboratory]: 'full',
    [HMS_ROLES.Pharmacy]: 'full',
    [HMS_ROLES.Accounts]: 'full',
  },
  patients: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'edit',
    [HMS_ROLES.Nurse]: 'edit',
    [HMS_ROLES.Doctor]: 'edit',
    [HMS_ROLES.Midwife]: 'edit',
    [HMS_ROLES.Laboratory]: 'view',
    [HMS_ROLES.Pharmacy]: 'view',
    [HMS_ROLES.Accounts]: 'view',
  },
  opd: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'edit',
    [HMS_ROLES.Nurse]: 'edit',
    [HMS_ROLES.Doctor]: 'full',
    [HMS_ROLES.Midwife]: 'view',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'none',
  },
  appointments: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'full',
    [HMS_ROLES.Nurse]: 'full',
    [HMS_ROLES.Doctor]: 'full',
    [HMS_ROLES.Midwife]: 'full',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'view',
  },
  anc: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'edit',
    [HMS_ROLES.Doctor]: 'edit',
    [HMS_ROLES.Midwife]: 'full',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'none',
  },
  maternity: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'view',
    [HMS_ROLES.Doctor]: 'edit',
    [HMS_ROLES.Midwife]: 'full',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'none',
  },
  pnc: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'edit',
    [HMS_ROLES.Doctor]: 'edit',
    [HMS_ROLES.Midwife]: 'full',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'none',
  },
  immunization: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'full',
    [HMS_ROLES.Doctor]: 'edit',
    [HMS_ROLES.Midwife]: 'full',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'none',
  },
  fp: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'full',
    [HMS_ROLES.Doctor]: 'edit',
    [HMS_ROLES.Midwife]: 'full',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'none',
  },
  hiv: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'none',
    [HMS_ROLES.Doctor]: 'full',
    [HMS_ROLES.Midwife]: 'full',
    [HMS_ROLES.Laboratory]: 'edit',
    [HMS_ROLES.Pharmacy]: 'edit',
    [HMS_ROLES.Accounts]: 'none',
  },
  lab: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'view',
    [HMS_ROLES.Doctor]: 'edit',
    [HMS_ROLES.Midwife]: 'edit',
    [HMS_ROLES.Laboratory]: 'full',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'none',
  },
  pharmacy: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'view',
    [HMS_ROLES.Doctor]: 'edit',
    [HMS_ROLES.Midwife]: 'edit',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'full',
    [HMS_ROLES.Accounts]: 'view',
  },
  billing: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'none',
    [HMS_ROLES.Doctor]: 'none',
    [HMS_ROLES.Midwife]: 'none',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'full',
  },
  reports: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'view',
    [HMS_ROLES.Nurse]: 'view',
    [HMS_ROLES.Doctor]: 'view',
    [HMS_ROLES.Midwife]: 'view',
    [HMS_ROLES.Laboratory]: 'view',
    [HMS_ROLES.Pharmacy]: 'view',
    [HMS_ROLES.Accounts]: 'view',
  },
  roles: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'none',
    [HMS_ROLES.Doctor]: 'none',
    [HMS_ROLES.Midwife]: 'none',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'none',
  },
  security: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'none',
    [HMS_ROLES.Doctor]: 'none',
    [HMS_ROLES.Midwife]: 'none',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'none',
  },
  doctors: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'none',
    [HMS_ROLES.Doctor]: 'full',
    [HMS_ROLES.Midwife]: 'none',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'none',
  },
  icu: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'view',
    [HMS_ROLES.Doctor]: 'view',
    [HMS_ROLES.Midwife]: 'none',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'none',
  },
  ambulance: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'view',
    [HMS_ROLES.Nurse]: 'view',
    [HMS_ROLES.Doctor]: 'view',
    [HMS_ROLES.Midwife]: 'none',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'none',
  },
  bloodbank: {
    [HMS_ROLES.Administrator]: 'full',
    [HMS_ROLES.Clerk]: 'none',
    [HMS_ROLES.Nurse]: 'edit',
    [HMS_ROLES.Doctor]: 'edit',
    [HMS_ROLES.Midwife]: 'none',
    [HMS_ROLES.Laboratory]: 'none',
    [HMS_ROLES.Pharmacy]: 'none',
    [HMS_ROLES.Accounts]: 'none',
  },
};

/** Fine-grained app_role allow-lists for existing module APIs / UI. */
export const EXISTING_MODULE_APP_ROLES = {
  doctors: ['Admin', 'Doctor'],
  icu: ['Admin', 'ICU'],
  ambulance: ['Admin', 'Ambulance'],
  bloodbank: ['Admin', 'BloodBank', 'Blood Bank'],
  volunteer: ['Admin', 'Volunteer'],
};

export function canAccessExistingModule(appRole, moduleKey) {
  const allowed = EXISTING_MODULE_APP_ROLES[moduleKey];
  if (!allowed) return false;
  return allowed.includes(appRole);
}

export function toHmsRole(appRole) {
  if (!appRole) return null;
  return APP_ROLE_TO_HMS[appRole] ?? null;
}

export function getPortalAccess(appRole, portalKey) {
  const hms = toHmsRole(appRole);
  if (!hms) return 'none';
  const row = PORTAL_MATRIX[portalKey];
  if (!row) return 'none';
  return row[hms] || 'none';
}

export function canSeePortal(appRole, portalKey, flags = {}) {
  const level = getPortalAccess(appRole, portalKey);
  if (level === 'none') return false;
  if (portalKey === 'hiv') return Boolean(flags.can_access_hiv);
  return true;
}

export function canExportReports(appRole, flags = {}) {
  if (toHmsRole(appRole) === HMS_ROLES.Administrator) return true;
  return Boolean(flags.can_export_reports);
}

export function normalizeFlags(profile = {}) {
  return {
    can_access_hiv: Boolean(profile.can_access_hiv),
    can_verify_lab: Boolean(profile.can_verify_lab),
    can_give_discounts: Boolean(profile.can_give_discounts),
    can_export_reports: Boolean(profile.can_export_reports),
  };
}
