import os

from flask import Blueprint, Response, request
from twilio.twiml.voice_response import VoiceResponse

from app import patient_service, voice_agent

bp = Blueprint("voice", __name__, url_prefix="/voice")

# In-memory conversation state keyed by CallSid. Fine for a single-instance demo deployment;
# see README "Known Limitations" for how this would need to change for multi-instance hosting.
call_states = {}

VOICE = os.environ.get("TWILIO_TTS_VOICE", "Polly.Joanna")
GATHER_TIMEOUT_MESSAGE = "I didn't catch that. Are you still there?"


def _build_gather_response(say, hangup):
    twiml = VoiceResponse()

    if hangup:
        twiml.say(say, voice=VOICE)
        twiml.hangup()
        return twiml

    gather = twiml.gather(
        input="speech",
        action="/voice/gather",
        method="POST",
        speech_timeout="auto",
        speech_model="phone_call",
    )
    gather.say(say, voice=VOICE)

    twiml.say(GATHER_TIMEOUT_MESSAGE, voice=VOICE)
    twiml.redirect("/voice/incoming?retry=1", method="POST")

    return twiml


def _finalize_call(call_sid, state):
    try:
        if state["transcript"]:
            transcript_text = "\n".join(f"{t['role']}: {t['text']}" for t in state["transcript"])
            patient_service.save_transcript(call_sid, state.get("saved_patient_id"), transcript_text)
            print(
                f"[voice] Call {call_sid} final payload:",
                {
                    "patientId": state.get("saved_patient_id"),
                    "matchedExistingPatientId": state.get("matched_existing_patient_id"),
                },
            )
    except Exception as err:  # noqa: BLE001
        print("[voice] Failed to persist transcript:", err)
    finally:
        call_states.pop(call_sid, None)


@bp.post("/incoming")
def incoming():
    call_sid = request.form.get("CallSid")
    print(f"[voice] Incoming call {call_sid} from {request.form.get('From')}")

    state = call_states.setdefault(call_sid, voice_agent.create_call_state())

    try:
        is_retry = request.args.get("retry") == "1"
        kickoff = (
            "The caller did not respond. Gently check if they are still on the line and continue helping them register."
            if is_retry
            else "The call just started. Greet the caller warmly, introduce yourself as the intake assistant, and ask how you can help (registering as a new patient)."
        )
        result = voice_agent.run_turn(state, kickoff)
        twiml = _build_gather_response(result["say"], result["hangup"])
        return Response(str(twiml), mimetype="text/xml")
    except Exception as err:  # noqa: BLE001
        print("[voice/incoming] error:", err)
        twiml = VoiceResponse()
        twiml.say("I'm sorry, we're experiencing a technical issue. Please call back in a few minutes.", voice=VOICE)
        twiml.hangup()
        return Response(str(twiml), mimetype="text/xml")


@bp.post("/gather")
def gather():
    call_sid = request.form.get("CallSid")
    speech_result = request.form.get("SpeechResult", "")
    print(f'[voice] {call_sid} said: "{speech_result}"')

    state = call_states.setdefault(call_sid, voice_agent.create_call_state())

    try:
        result = voice_agent.run_turn(state, speech_result or "(no speech detected, please re-prompt)")
        twiml = _build_gather_response(result["say"], result["hangup"])
        response = Response(str(twiml), mimetype="text/xml")
        if result["hangup"]:
            _finalize_call(call_sid, state)
        return response
    except Exception as err:  # noqa: BLE001
        print("[voice/gather] error:", err)
        twiml = VoiceResponse()
        twiml.say(
            "I'm sorry, something went wrong on our end saving your information. Please try calling back shortly.",
            voice=VOICE,
        )
        twiml.hangup()
        _finalize_call(call_sid, state)
        return Response(str(twiml), mimetype="text/xml")


@bp.post("/status")
def status():
    call_sid = request.form.get("CallSid")
    call_status = request.form.get("CallStatus")
    print(f"[voice/status] {call_sid} -> {call_status}")

    if call_status in ("completed", "failed", "busy", "no-answer", "canceled"):
        state = call_states.get(call_sid)
        if state:
            _finalize_call(call_sid, state)

    return "OK", 200
