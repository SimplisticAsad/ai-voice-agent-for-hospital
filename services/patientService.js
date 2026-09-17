const { randomUUID } = require('crypto');
const db = require('../db/database');
const { validatePatientPayload, ALL_FIELDS, onlyDigits } = require('./validators');

class ValidationError extends Error {
  constructor(errors) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

class NotFoundError extends Error {
  constructor(message = 'Patient not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

const COLUMNS = [
  'patient_id', 'first_name', 'last_name', 'date_of_birth', 'sex', 'phone_number', 'email',
  'address_line_1', 'address_line_2', 'city', 'state', 'zip_code',
  'insurance_provider', 'insurance_member_id', 'preferred_language',
  'emergency_contact_name', 'emergency_contact_phone', 'created_at', 'updated_at', 'deleted_at'
];

function rowToPatient(row) {
  if (!row) return null;
  const patient = {};
  for (const col of COLUMNS) patient[col] = row[col] === undefined ? null : row[col];
  return patient;
}

function listPatients({ last_name, date_of_birth, phone_number } = {}) {
  let query = 'SELECT * FROM patients WHERE deleted_at IS NULL';
  const params = [];

  if (last_name) {
    query += ' AND last_name = ? COLLATE NOCASE';
    params.push(last_name);
  }
  if (date_of_birth) {
    query += ' AND date_of_birth = ?';
    params.push(date_of_birth);
  }
  if (phone_number) {
    query += ' AND phone_number = ?';
    params.push(onlyDigits(phone_number));
  }
  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params);
  return rows.map(rowToPatient);
}

function getPatientById(patientId) {
  const row = db.prepare('SELECT * FROM patients WHERE patient_id = ? AND deleted_at IS NULL').get(patientId);
  return rowToPatient(row);
}

function findByPhone(phoneNumber) {
  const digits = onlyDigits(phoneNumber);
  if (digits.length !== 10) return null;
  const row = db.prepare('SELECT * FROM patients WHERE phone_number = ? AND deleted_at IS NULL').get(digits);
  return rowToPatient(row);
}

function createPatient(payload) {
  const { valid, errors, normalized } = validatePatientPayload(payload, { partial: false });
  if (!valid) throw new ValidationError(errors);

  const now = new Date().toISOString();
  const patient_id = randomUUID();
  const record = {
    patient_id,
    preferred_language: 'English',
    ...normalized,
    created_at: now,
    updated_at: now
  };

  for (const col of COLUMNS) {
    if (!(col in record)) record[col] = null;
  }

  db.prepare(`
    INSERT INTO patients (
      patient_id, first_name, last_name, date_of_birth, sex, phone_number, email,
      address_line_1, address_line_2, city, state, zip_code,
      insurance_provider, insurance_member_id, preferred_language,
      emergency_contact_name, emergency_contact_phone, created_at, updated_at
    ) VALUES (@patient_id, @first_name, @last_name, @date_of_birth, @sex, @phone_number, @email,
      @address_line_1, @address_line_2, @city, @state, @zip_code,
      @insurance_provider, @insurance_member_id, @preferred_language,
      @emergency_contact_name, @emergency_contact_phone, @created_at, @updated_at)
  `).run(record);

  return getPatientById(patient_id);
}

function updatePatient(patientId, payload) {
  const existing = getPatientById(patientId);
  if (!existing) throw new NotFoundError();

  const { valid, errors, normalized } = validatePatientPayload(payload, { partial: true });
  if (!valid) throw new ValidationError(errors);

  const updates = { ...normalized, updated_at: new Date().toISOString() };
  const setClauses = Object.keys(updates).map((key) => `${key} = @${key}`).join(', ');
  if (!setClauses) return existing;

  db.prepare(`UPDATE patients SET ${setClauses} WHERE patient_id = @patient_id`)
    .run({ ...updates, patient_id: patientId });

  return getPatientById(patientId);
}

function softDeletePatient(patientId) {
  const existing = getPatientById(patientId);
  if (!existing) throw new NotFoundError();
  db.prepare('UPDATE patients SET deleted_at = ?, updated_at = ? WHERE patient_id = ?')
    .run(new Date().toISOString(), new Date().toISOString(), patientId);
  return true;
}

function saveTranscript({ callSid, patientId, transcript }) {
  db.prepare('INSERT INTO call_transcripts (id, call_sid, patient_id, transcript, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), callSid, patientId || null, transcript, new Date().toISOString());
}

module.exports = {
  ValidationError,
  NotFoundError,
  listPatients,
  getPatientById,
  findByPhone,
  createPatient,
  updatePatient,
  softDeletePatient,
  saveTranscript,
  ALL_FIELDS
};
