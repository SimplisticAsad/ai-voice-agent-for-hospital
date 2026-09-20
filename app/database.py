import os
import sqlite3
import uuid
from datetime import datetime, timezone
from threading import Lock

DB_PATH = os.environ.get("DATABASE_PATH", os.path.join(os.path.dirname(os.path.dirname(__file__)), "patients.db"))

_lock = Lock()
_connection = None


def _now():
    return datetime.now(timezone.utc).isoformat()


def get_connection():
    global _connection
    if _connection is None:
        _connection = sqlite3.connect(DB_PATH, check_same_thread=False)
        _connection.row_factory = sqlite3.Row
        _connection.execute("PRAGMA journal_mode=WAL")
        _connection.execute("PRAGMA foreign_keys=ON")
    return _connection


SCHEMA = """
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
"""

SEED_PATIENTS = [
    {
        "patient_id": str(uuid.uuid4()),
        "first_name": "Jane",
        "last_name": "Doe",
        "date_of_birth": "1990-05-14",
        "sex": "Female",
        "phone_number": "5551234567",
        "email": "jane.doe@example.com",
        "address_line_1": "123 Main St",
        "address_line_2": None,
        "city": "Springfield",
        "state": "IL",
        "zip_code": "62704",
        "insurance_provider": "Blue Cross",
        "insurance_member_id": "BC123456",
        "preferred_language": "English",
        "emergency_contact_name": "John Doe",
        "emergency_contact_phone": "5559876543",
    },
    {
        "patient_id": str(uuid.uuid4()),
        "first_name": "Carlos",
        "last_name": "O'Brien",
        "date_of_birth": "1985-11-02",
        "sex": "Male",
        "phone_number": "5552223333",
        "email": None,
        "address_line_1": "456 Oak Ave",
        "address_line_2": "Apt 2B",
        "city": "Austin",
        "state": "TX",
        "zip_code": "73301",
        "insurance_provider": None,
        "insurance_member_id": None,
        "preferred_language": "Spanish",
        "emergency_contact_name": None,
        "emergency_contact_phone": None,
    },
]


def init_db():
    with _lock:
        conn = get_connection()
        conn.executescript(SCHEMA)
        conn.commit()

        count = conn.execute("SELECT COUNT(*) AS c FROM patients").fetchone()["c"]
        if count == 0:
            now = _now()
            for seed in SEED_PATIENTS:
                record = dict(seed)
                record["created_at"] = now
                record["updated_at"] = now
                conn.execute(
                    """
                    INSERT INTO patients (
                      patient_id, first_name, last_name, date_of_birth, sex, phone_number, email,
                      address_line_1, address_line_2, city, state, zip_code,
                      insurance_provider, insurance_member_id, preferred_language,
                      emergency_contact_name, emergency_contact_phone, created_at, updated_at
                    ) VALUES (
                      :patient_id, :first_name, :last_name, :date_of_birth, :sex, :phone_number, :email,
                      :address_line_1, :address_line_2, :city, :state, :zip_code,
                      :insurance_provider, :insurance_member_id, :preferred_language,
                      :emergency_contact_name, :emergency_contact_phone, :created_at, :updated_at
                    )
                    """,
                    record,
                )
            conn.commit()
            print("[db] Seeded 2 demo patient records")
