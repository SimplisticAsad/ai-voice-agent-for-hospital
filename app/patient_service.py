import uuid
from datetime import datetime, timezone

from app.database import get_connection
from app.validators import validate_patient_payload, only_digits

COLUMNS = [
    "patient_id", "first_name", "last_name", "date_of_birth", "sex", "phone_number", "email",
    "address_line_1", "address_line_2", "city", "state", "zip_code",
    "insurance_provider", "insurance_member_id", "preferred_language",
    "emergency_contact_name", "emergency_contact_phone", "created_at", "updated_at", "deleted_at",
]


class ValidationError(Exception):
    def __init__(self, errors):
        super().__init__("Validation failed")
        self.errors = errors


class NotFoundError(Exception):
    def __init__(self, message="Patient not found"):
        super().__init__(message)


def _now():
    return datetime.now(timezone.utc).isoformat()


def _row_to_patient(row):
    if row is None:
        return None
    return {col: row[col] for col in COLUMNS}


def list_patients(last_name=None, date_of_birth=None, phone_number=None):
    conn = get_connection()
    query = "SELECT * FROM patients WHERE deleted_at IS NULL"
    params = []

    if last_name:
        query += " AND last_name = ? COLLATE NOCASE"
        params.append(last_name)
    if date_of_birth:
        query += " AND date_of_birth = ?"
        params.append(date_of_birth)
    if phone_number:
        query += " AND phone_number = ?"
        params.append(only_digits(phone_number))

    query += " ORDER BY created_at DESC"
    rows = conn.execute(query, params).fetchall()
    return [_row_to_patient(r) for r in rows]


def get_patient_by_id(patient_id):
    conn = get_connection()
    row = conn.execute(
        "SELECT * FROM patients WHERE patient_id = ? AND deleted_at IS NULL", (patient_id,)
    ).fetchone()
    return _row_to_patient(row)


def find_by_phone(phone_number):
    digits = only_digits(phone_number)
    if len(digits) != 10:
        return None
    conn = get_connection()
    row = conn.execute(
        "SELECT * FROM patients WHERE phone_number = ? AND deleted_at IS NULL", (digits,)
    ).fetchone()
    return _row_to_patient(row)


def create_patient(payload):
    result = validate_patient_payload(payload, partial=False)
    if not result["valid"]:
        raise ValidationError(result["errors"])

    now = _now()
    patient_id = str(uuid.uuid4())
    record = {col: None for col in COLUMNS}
    record.update(result["normalized"])
    record["patient_id"] = patient_id
    record.setdefault("preferred_language", None)
    if not record.get("preferred_language"):
        record["preferred_language"] = "English"
    record["created_at"] = now
    record["updated_at"] = now
    record["deleted_at"] = None

    conn = get_connection()
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
    return get_patient_by_id(patient_id)


def update_patient(patient_id, payload):
    existing = get_patient_by_id(patient_id)
    if not existing:
        raise NotFoundError()

    result = validate_patient_payload(payload, partial=True)
    if not result["valid"]:
        raise ValidationError(result["errors"])

    updates = dict(result["normalized"])
    if not updates:
        return existing
    updates["updated_at"] = _now()
    updates["patient_id"] = patient_id

    set_clause = ", ".join(f"{k} = :{k}" for k in updates if k != "patient_id")
    conn = get_connection()
    conn.execute(f"UPDATE patients SET {set_clause} WHERE patient_id = :patient_id", updates)
    conn.commit()
    return get_patient_by_id(patient_id)


def soft_delete_patient(patient_id):
    existing = get_patient_by_id(patient_id)
    if not existing:
        raise NotFoundError()
    conn = get_connection()
    now = _now()
    conn.execute(
        "UPDATE patients SET deleted_at = ?, updated_at = ? WHERE patient_id = ?",
        (now, now, patient_id),
    )
    conn.commit()
    return True


def save_transcript(call_sid, patient_id, transcript):
    conn = get_connection()
    conn.execute(
        "INSERT INTO call_transcripts (id, call_sid, patient_id, transcript, created_at) VALUES (?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), call_sid, patient_id, transcript, _now()),
    )
    conn.commit()
