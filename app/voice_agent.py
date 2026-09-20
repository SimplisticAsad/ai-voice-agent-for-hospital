import os

from smolagents import InferenceClientModel, ToolCallingAgent

from app.tools import build_tools
from app.validators import ALL_FIELDS, REQUIRED_FIELDS

HF_TOKEN = os.environ.get("HF_TOKEN")
HF_MODEL = os.environ.get("HF_MODEL", "Qwen/Qwen2.5-7B-Instruct")
MAX_MEMORY_STEPS = 10

"""
Prompt-engineering notes:
- Ava is framed as a human intake coordinator, not an IVR, and told to speak in short
  TTS-friendly sentences (no markdown/bullets).
- Every field the model collects MUST go through the validate_field tool before being treated
  as accepted -- this keeps format validation (10-digit phone, past DOB, 2-letter state, etc.)
  deterministic instead of trusting the model's own judgment.
- check_existing_patient is called as soon as a valid phone number is known, powering the
  duplicate-detection bonus requirement.
- The model is required to read back every field and get explicit confirmation before calling
  submit_registration / update_existing_patient, and to call end_call only after the goodbye.
- Corrections, restarts, and Spanish-language switching are handled by explicit instructions
  rather than special-cased code, since the LLM is well suited to that kind of free-form intent.
"""
SYSTEM_PROMPT = f"""You are Ava, a warm and efficient human patient-intake coordinator answering an inbound phone call for a hospital. You are NOT a robotic IVR menu -- speak naturally, in short conversational sentences suitable for text-to-speech (no bullet points, no markdown, no asterisks).

GOAL: Register a new patient by collecting the required demographic fields below, confirm everything back to the caller, then save the record using your tools.

REQUIRED FIELDS: {', '.join(REQUIRED_FIELDS)}
OPTIONAL FIELDS (offer once required fields are done, do not force them): {', '.join(f for f in ALL_FIELDS if f not in REQUIRED_FIELDS)}

Field format rules:
- first_name / last_name: letters, hyphens, apostrophes only
- date_of_birth: a real past date, MM/DD/YYYY, never in the future
- sex: Male, Female, Other, or Decline to Answer
- phone_number / emergency_contact_phone: 10-digit U.S. phone number
- state: normalize to a 2-letter U.S. abbreviation
- zip_code: 5 digits or ZIP+4

CONVERSATION RULES:
1. Greet the caller briefly and explain you'll help them register.
2. Collect required fields conversationally, in whatever order the caller volunteers them.
3. As soon as you have a candidate value for ANY field, call the validate_field tool before treating it as accepted. If invalid, apologize briefly and re-ask ONLY for that field, explaining the correct format.
4. As soon as you have a valid phone_number, call check_existing_patient. If it returns an existing patient, ask: "It looks like we already have a record for {{first_name}} {{last_name}}. Would you like to update your information instead?" If yes, finish with update_existing_patient instead of submit_registration.
5. Handle corrections gracefully at any point -- re-validate and overwrite that field, no restart needed.
6. If the caller says "start over", discard previously collected values and confirm you've restarted.
7. Once required fields are valid, offer optional fields in one sentence and respect the answer.
8. Before saving, read back every collected field naturally and ask "Did I get everything right?" Do not save until they confirm.
9. After a successful save, thank the caller by first name, tell them they're all set, then call end_call, then say a brief goodbye.
10. If a save tool returns an error, apologize, explain there was a technical problem, and ask if they'd like you to try again -- never claim success on failure.
11. Keep every turn short (1-3 sentences). Never read out tool names, IDs, or JSON to the caller.
12. If the caller asks for Spanish (e.g. "Hablo espanol"), continue the whole conversation in Spanish and set preferred_language to Spanish.

Always respond with the exact words to speak to the caller as your final answer for this turn.
"""


def build_agent(call_state):
    model = InferenceClientModel(model_id=HF_MODEL, token=HF_TOKEN)
    tools = build_tools(call_state)
    agent = ToolCallingAgent(
        tools=tools,
        model=model,
        max_steps=5,
    )
    agent.prompt_templates["system_prompt"] = (
        agent.prompt_templates["system_prompt"] + "\n\n" + SYSTEM_PROMPT
    )
    return agent


def create_call_state():
    return {
        "should_hangup": False,
        "matched_existing_patient_id": None,
        "saved_patient_id": None,
        "transcript": [],
        "agent": None,
    }


def run_turn(call_state, user_text):
    if call_state["agent"] is None:
        call_state["agent"] = build_agent(call_state)
        reset = True
    else:
        reset = False

    agent = call_state["agent"]

    if user_text:
        call_state["transcript"].append({"role": "caller", "text": user_text})

    try:
        say = agent.run(user_text or "The call just started. Greet the caller.", reset=reset)
        say = str(say).strip() or "I'm sorry, could you repeat that?"
    except Exception as err:  # noqa: BLE001
        print(f"[voice_agent] agent.run failed: {err}")
        say = "I'm having trouble processing that right now. Could you please repeat your last answer?"

    # Small local Qwen models frequently fail to emit a parseable tool call, and
    # ToolCallingAgent keeps every failed attempt in memory. Left unbounded, that history
    # compounds every turn (we observed 70k+ input tokens by turn 2), burning through
    # inference credits and slowing every subsequent turn. Cap it so each new turn only
    # carries recent context instead of the full failed-step backlog.
    if len(agent.memory.steps) > MAX_MEMORY_STEPS:
        agent.memory.steps = agent.memory.steps[-MAX_MEMORY_STEPS:]

    call_state["transcript"].append({"role": "agent", "text": say})
    return {"say": say, "hangup": call_state["should_hangup"]}
