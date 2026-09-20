from flask import Blueprint, jsonify, request

from app import patient_service

bp = Blueprint("patients", __name__, url_prefix="/patients")


def envelope(data, error=None):
    return jsonify({"data": data, "error": error})


@bp.get("")
def list_patients():
    try:
        patients = patient_service.list_patients(
            last_name=request.args.get("last_name"),
            date_of_birth=request.args.get("date_of_birth"),
            phone_number=request.args.get("phone_number"),
        )
        return envelope(patients), 200
    except Exception as err:  # noqa: BLE001
        print("[GET /patients] error:", err)
        return envelope(None, "Internal server error"), 500


@bp.get("/<patient_id>")
def get_patient(patient_id):
    try:
        patient = patient_service.get_patient_by_id(patient_id)
        if not patient:
            return envelope(None, "Patient not found"), 404
        return envelope(patient), 200
    except Exception as err:  # noqa: BLE001
        print("[GET /patients/:id] error:", err)
        return envelope(None, "Internal server error"), 500


@bp.post("")
def create_patient():
    try:
        payload = request.get_json(silent=True) or {}
        patient = patient_service.create_patient(payload)
        return envelope(patient), 201
    except patient_service.ValidationError as err:
        return envelope(None, {"message": "Validation failed", "fields": err.errors}), 422
    except Exception as err:  # noqa: BLE001
        print("[POST /patients] error:", err)
        return envelope(None, "Internal server error"), 500


@bp.put("/<patient_id>")
def update_patient(patient_id):
    try:
        payload = request.get_json(silent=True) or {}
        patient = patient_service.update_patient(patient_id, payload)
        return envelope(patient), 200
    except patient_service.NotFoundError:
        return envelope(None, "Patient not found"), 404
    except patient_service.ValidationError as err:
        return envelope(None, {"message": "Validation failed", "fields": err.errors}), 422
    except Exception as err:  # noqa: BLE001
        print("[PUT /patients/:id] error:", err)
        return envelope(None, "Internal server error"), 500


@bp.delete("/<patient_id>")
def delete_patient(patient_id):
    try:
        patient_service.soft_delete_patient(patient_id)
        return envelope({"deleted": True}), 200
    except patient_service.NotFoundError:
        return envelope(None, "Patient not found"), 404
    except Exception as err:  # noqa: BLE001
        print("[DELETE /patients/:id] error:", err)
        return envelope(None, "Internal server error"), 500
