const Database = require('better-sqlite3');
const path = require('path');
const { randomUUID } = require('crypto');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'patients.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS patients (
  patient_id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  sex TEXT NOT NULL CHECK (sex IN ('Male', 'Female', 'Other', 'Decline to Answer')),
  phone_number TEXT NOT NULL,
  email TEXT,
  address_line_1 TEXT NOT NULL,
  address_line_2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip_code TEXT NOT NULL,
  insurance_provider TEXT,
  insurance_member_id TEXT,
  preferred_language TEXT DEFAULT 'English',
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone_number);
CREATE INDEX IF NOT EXISTS idx_patients_last_name ON patients(last_name);
CREATE INDEX IF NOT EXISTS idx_patients_dob ON patients(date_of_birth);

CREATE TABLE IF NOT EXISTS call_transcripts (
  id TEXT PRIMARY KEY,
  call_sid TEXT NOT NULL,
  patient_id TEXT,
  transcript TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

// Seed a couple of demo records if the table is empty
const count = db.prepare('SELECT COUNT(*) AS c FROM patients').get().c;
if (count === 0) {
  const now = new Date().toISOString();
  const seed = db.prepare(`
    INSERT INTO patients (
      patient_id, first_name, last_name, date_of_birth, sex, phone_number, email,
      address_line_1, address_line_2, city, state, zip_code,
      insurance_provider, insurance_member_id, preferred_language,
      emergency_contact_name, emergency_contact_phone, created_at, updated_at
    ) VALUES (@patient_id, @first_name, @last_name, @date_of_birth, @sex, @phone_number, @email,
      @address_line_1, @address_line_2, @city, @state, @zip_code,
      @insurance_provider, @insurance_member_id, @preferred_language,
      @emergency_contact_name, @emergency_contact_phone, @created_at, @updated_at)
  `);
  seed.run({
    patient_id: randomUUID(),
    first_name: 'Jane',
    last_name: 'Doe',
    date_of_birth: '1990-05-14',
    sex: 'Female',
    phone_number: '5551234567',
    email: 'jane.doe@example.com',
    address_line_1: '123 Main St',
    address_line_2: null,
    city: 'Springfield',
    state: 'IL',
    zip_code: '62704',
    insurance_provider: 'Blue Cross',
    insurance_member_id: 'BC123456',
    preferred_language: 'English',
    emergency_contact_name: 'John Doe',
    emergency_contact_phone: '5559876543',
    created_at: now,
    updated_at: now
  });
  seed.run({
    patient_id: randomUUID(),
    first_name: 'Carlos',
    last_name: "O'Brien",
    date_of_birth: '1985-11-02',
    sex: 'Male',
    phone_number: '5552223333',
    email: null,
    address_line_1: '456 Oak Ave',
    address_line_2: 'Apt 2B',
    city: 'Austin',
    state: 'TX',
    zip_code: '73301',
    insurance_provider: null,
    insurance_member_id: null,
    preferred_language: 'Spanish',
    emergency_contact_name: null,
    emergency_contact_phone: null,
    created_at: now,
    updated_at: now
  });
  console.log('[db] Seeded 2 demo patient records');
}

module.exports = db;
