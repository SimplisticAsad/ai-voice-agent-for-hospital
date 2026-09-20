import json

from smolagents import Tool

from app import patient_service
from app.validators import ALL_FIELDS, validate_field


class ValidateFieldTool(Tool):
    name = "validate_field"
    description = (
        "Validate and normalize a single patient field value against server-side rules "
        "before accepting it. Always call this before treating a spoken value as final."
    )
    inputs = {
        "field": {
            "type": "string",
            "description": f"One of: {', '.join(ALL_FIELDS)}",
        },
        "value": {
            "type": "string",
            "description": "The raw value as spoken/transcribed from the caller.",
        },
    }
    output_type = "string"

    def forward(self, field: str, value: str) -> str:
        result = validate_field(field, value)
        return json.dumps(result)


class CheckExistingPatientTool(Tool):
    name = "check_existing_patient"
    description = "Look up whether a patient with this phone number already exists in the system."
    inputs = {
        "phone_number": {"type": "string", "description": "10-digit U.S. phone number."},
    }
    output_type = "string"

    def __init__(self, call_state, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.call_state = call_state

    def forward(self, phone_number: str) -> str:
        patient = patient_service.find_by_phone(phone_number)
        if patient:
            self.call_state["matched_existing_patient_id"] = patient["patient_id"]
        return json.dumps({"found": bool(patient), "patient": patient})


class SubmitRegistrationTool(Tool):
    name = "submit_registration"
    description = (
        "Persist a new patient record after the caller has confirmed all details are correct. "
        "Pass every field you collected as keyword arguments."
    )
    inputs = {field: {"type": "string", "description": field, "nullable": True} for field in ALL_FIELDS}
    output_type = "string"
    skip_forward_signature_validation = True

    def __init__(self, call_state, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.call_state = call_state

    def forward(self, **kwargs) -> str:
        try:
            patient = patient_service.create_patient(kwargs)
            self.call_state["saved_patient_id"] = patient["patient_id"]
            return json.dumps({"success": True, "patient": patient})
        except patient_service.ValidationError as err:
            return json.dumps({"success": False, "error": "validation_failed", "fields": err.errors})
        except Exception as err:  # noqa: BLE001
            return json.dumps({"success": False, "error": "internal_error", "message": str(err)})


class UpdateExistingPatientTool(Tool):
    name = "update_existing_patient"
    description = (
        "Update an existing patient record (found via check_existing_patient) after the caller "
        "confirms the changes. patient_id is required; other fields are optional partial updates."
    )
    inputs = {
        "patient_id": {"type": "string", "description": "The existing patient's UUID."},
        **{field: {"type": "string", "description": field, "nullable": True} for field in ALL_FIELDS},
    }
    output_type = "string"
    skip_forward_signature_validation = True

    def __init__(self, call_state, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.call_state = call_state

    def forward(self, patient_id: str, **kwargs) -> str:
        try:
            patient = patient_service.update_patient(patient_id, kwargs)
            self.call_state["saved_patient_id"] = patient["patient_id"]
            return json.dumps({"success": True, "patient": patient})
        except patient_service.NotFoundError:
            return json.dumps({"success": False, "error": "not_found"})
        except patient_service.ValidationError as err:
            return json.dumps({"success": False, "error": "validation_failed", "fields": err.errors})
        except Exception as err:  # noqa: BLE001
            return json.dumps({"success": False, "error": "internal_error", "message": str(err)})


class EndCallTool(Tool):
    name = "end_call"
    description = "Call this once you have said your final goodbye and the call should be hung up."
    inputs = {}
    output_type = "string"

    def __init__(self, call_state, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.call_state = call_state

    def forward(self) -> str:
        self.call_state["should_hangup"] = True
        return json.dumps({"ok": True})


def build_tools(call_state):
    return [
        ValidateFieldTool(),
        CheckExistingPatientTool(call_state),
        SubmitRegistrationTool(call_state),
        UpdateExistingPatientTool(call_state),
        EndCallTool(call_state),
    ]
