const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
  'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
  'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
]);

const NAME_RE = /^[A-Za-z' -]{1,50}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;

function onlyDigits(str) {
  return String(str || '').replace(/\D/g, '');
}

function isValidName(value) {
  return typeof value === 'string' && NAME_RE.test(value.trim());
}

function isValidDob(value) {
  // Expect ISO YYYY-MM-DD or MM/DD/YYYY
  if (typeof value !== 'string') return false;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const us = /^\d{2}\/\d{2}\/\d{4}$/;
  let date;
  if (iso.test(value)) {
    date = new Date(value + 'T00:00:00Z');
  } else if (us.test(value)) {
    const [m, d, y] = value.split('/');
    date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  } else {
    return false;
  }
  if (isNaN(date.getTime())) return false;
  if (date.getTime() > Date.now()) return false;
  if (date.getUTCFullYear() < 1900) return false;
  return true;
}

function normalizeDob(value) {
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  const match = value.match(us);
  if (match) {
    const [, m, d, y] = match;
    return `${y}-${m}-${d}`;
  }
  return value;
}

function isValidSex(value) {
  return ['Male', 'Female', 'Other', 'Decline to Answer'].includes(value);
}

function isValidPhone(value) {
  return onlyDigits(value).length === 10;
}

function normalizePhone(value) {
  return onlyDigits(value);
}

function isValidEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value.trim());
}

function isValidState(value) {
  return typeof value === 'string' && US_STATES.has(value.trim().toUpperCase());
}

function isValidZip(value) {
  return typeof value === 'string' && ZIP_RE.test(value.trim());
}

function isValidCity(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 100;
}

const REQUIRED_FIELDS = [
  'first_name', 'last_name', 'date_of_birth', 'sex', 'phone_number',
  'address_line_1', 'city', 'state', 'zip_code'
];

const OPTIONAL_FIELDS = [
  'email', 'address_line_2', 'insurance_provider', 'insurance_member_id',
  'preferred_language', 'emergency_contact_name', 'emergency_contact_phone'
];

const ALL_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

// Returns { valid: bool, error: string|null, normalized: any }
function validateField(field, value) {
  if (value === undefined || value === null || value === '') {
    if (REQUIRED_FIELDS.includes(field)) {
      return { valid: false, error: `${field} is required` };
    }
    return { valid: true, normalized: undefined };
  }

  switch (field) {
    case 'first_name':
    case 'last_name':
    case 'emergency_contact_name':
      return isValidName(value)
        ? { valid: true, normalized: value.trim() }
        : { valid: false, error: `${field} must be 1-50 alphabetic characters (hyphens/apostrophes allowed)` };
    case 'date_of_birth':
      return isValidDob(value)
        ? { valid: true, normalized: normalizeDob(value) }
        : { valid: false, error: 'date_of_birth must be a valid past date (MM/DD/YYYY)' };
    case 'sex':
      return isValidSex(value)
        ? { valid: true, normalized: value }
        : { valid: false, error: 'sex must be one of Male, Female, Other, Decline to Answer' };
    case 'phone_number':
    case 'emergency_contact_phone':
      return isValidPhone(value)
        ? { valid: true, normalized: normalizePhone(value) }
        : { valid: false, error: `${field} must be a valid 10-digit U.S. phone number` };
    case 'email':
      return isValidEmail(value)
        ? { valid: true, normalized: value.trim().toLowerCase() }
        : { valid: false, error: 'email must be a valid email address' };
    case 'city':
      return isValidCity(value)
        ? { valid: true, normalized: value.trim() }
        : { valid: false, error: 'city must be 1-100 characters' };
    case 'state':
      return isValidState(value)
        ? { valid: true, normalized: value.trim().toUpperCase() }
        : { valid: false, error: 'state must be a valid 2-letter U.S. state abbreviation' };
    case 'zip_code':
      return isValidZip(value)
        ? { valid: true, normalized: value.trim() }
        : { valid: false, error: 'zip_code must be 5 digits or ZIP+4 format' };
    case 'address_line_1':
    case 'address_line_2':
    case 'insurance_provider':
    case 'insurance_member_id':
    case 'preferred_language':
      return { valid: true, normalized: String(value).trim() };
    default:
      return { valid: false, error: `Unknown field: ${field}` };
  }
}

// Validates a full patient payload; returns { valid, errors: {field: msg}, normalized }
function validatePatientPayload(payload, { partial = false } = {}) {
  const errors = {};
  const normalized = {};

  const fieldsToCheck = partial
    ? Object.keys(payload).filter((f) => ALL_FIELDS.includes(f))
    : ALL_FIELDS;

  for (const field of fieldsToCheck) {
    const value = payload[field];
    if (partial && !(field in payload)) continue;
    const result = validateField(field, value);
    if (!result.valid) {
      errors[field] = result.error;
    } else if (result.normalized !== undefined) {
      normalized[field] = result.normalized;
    }
  }

  if (!partial) {
    for (const field of REQUIRED_FIELDS) {
      if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
        errors[field] = errors[field] || `${field} is required`;
      }
    }
  }

  return { valid: Object.keys(errors).length === 0, errors, normalized };
}

module.exports = {
  REQUIRED_FIELDS,
  OPTIONAL_FIELDS,
  ALL_FIELDS,
  validateField,
  validatePatientPayload,
  onlyDigits
};
