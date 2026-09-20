import re
from datetime import datetime, timezone

US_STATES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
    "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT",
    "VA", "WA", "WV", "WI", "WY", "DC",
}

NAME_RE = re.compile(r"^[A-Za-z' -]{1,50}$")
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
ZIP_RE = re.compile(r"^\d{5}(-\d{4})?$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
US_DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")

REQUIRED_FIELDS = [
    "first_name", "last_name", "date_of_birth", "sex", "phone_number",
    "address_line_1", "city", "state", "zip_code",
]

OPTIONAL_FIELDS = [
    "email", "address_line_2", "insurance_provider", "insurance_member_id",
    "preferred_language", "emergency_contact_name", "emergency_contact_phone",
]

ALL_FIELDS = REQUIRED_FIELDS + OPTIONAL_FIELDS


def only_digits(value):
    return re.sub(r"\D", "", str(value or ""))


def _is_valid_name(value):
    return isinstance(value, str) and bool(NAME_RE.match(value.strip()))


def _normalize_dob(value):
    match = US_DATE_RE.match(value)
    if match:
        m, d, y = value.split("/")
        return f"{y}-{m}-{d}"
    return value


def _is_valid_dob(value):
    if not isinstance(value, str):
        return False
    if ISO_DATE_RE.match(value):
        try:
            date = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            return False
    elif US_DATE_RE.match(value):
        try:
            date = datetime.strptime(value, "%m/%d/%Y").replace(tzinfo=timezone.utc)
        except ValueError:
            return False
    else:
        return False
    if date > datetime.now(timezone.utc):
        return False
    if date.year < 1900:
        return False
    return True


def _is_valid_sex(value):
    return value in ("Male", "Female", "Other", "Decline to Answer")


def _is_valid_phone(value):
    return len(only_digits(value)) == 10


def _is_valid_email(value):
    return isinstance(value, str) and bool(EMAIL_RE.match(value.strip()))


def _is_valid_state(value):
    return isinstance(value, str) and value.strip().upper() in US_STATES


def _is_valid_zip(value):
    return isinstance(value, str) and bool(ZIP_RE.match(value.strip()))


def _is_valid_city(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= 100


def validate_field(field, value):
    """Returns dict: {"valid": bool, "error": str|None, "normalized": any}"""
    if value is None or value == "":
        if field in REQUIRED_FIELDS:
            return {"valid": False, "error": f"{field} is required"}
        return {"valid": True, "normalized": None}

    if field in ("first_name", "last_name", "emergency_contact_name"):
        if _is_valid_name(value):
            return {"valid": True, "normalized": value.strip()}
        return {"valid": False, "error": f"{field} must be 1-50 alphabetic characters (hyphens/apostrophes allowed)"}

    if field == "date_of_birth":
        if _is_valid_dob(value):
            return {"valid": True, "normalized": _normalize_dob(value)}
        return {"valid": False, "error": "date_of_birth must be a valid past date (MM/DD/YYYY)"}

    if field == "sex":
        if _is_valid_sex(value):
            return {"valid": True, "normalized": value}
        return {"valid": False, "error": "sex must be one of Male, Female, Other, Decline to Answer"}

    if field in ("phone_number", "emergency_contact_phone"):
        if _is_valid_phone(value):
            return {"valid": True, "normalized": only_digits(value)}
        return {"valid": False, "error": f"{field} must be a valid 10-digit U.S. phone number"}

    if field == "email":
        if _is_valid_email(value):
            return {"valid": True, "normalized": value.strip().lower()}
        return {"valid": False, "error": "email must be a valid email address"}

    if field == "city":
        if _is_valid_city(value):
            return {"valid": True, "normalized": value.strip()}
        return {"valid": False, "error": "city must be 1-100 characters"}

    if field == "state":
        if _is_valid_state(value):
            return {"valid": True, "normalized": value.strip().upper()}
        return {"valid": False, "error": "state must be a valid 2-letter U.S. state abbreviation"}

    if field == "zip_code":
        if _is_valid_zip(value):
            return {"valid": True, "normalized": value.strip()}
        return {"valid": False, "error": "zip_code must be 5 digits or ZIP+4 format"}

    if field in ("address_line_1", "address_line_2", "insurance_provider", "insurance_member_id", "preferred_language"):
        return {"valid": True, "normalized": str(value).strip()}

    return {"valid": False, "error": f"Unknown field: {field}"}


def validate_patient_payload(payload, partial=False):
    errors = {}
    normalized = {}

    fields_to_check = [f for f in payload.keys() if f in ALL_FIELDS] if partial else ALL_FIELDS

    for field in fields_to_check:
        if partial and field not in payload:
            continue
        value = payload.get(field)
        result = validate_field(field, value)
        if not result["valid"]:
            errors[field] = result["error"]
        elif result.get("normalized") is not None:
            normalized[field] = result["normalized"]

    if not partial:
        for field in REQUIRED_FIELDS:
            if not payload.get(field):
                errors.setdefault(field, f"{field} is required")

    return {"valid": len(errors) == 0, "errors": errors, "normalized": normalized}
