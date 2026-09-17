const OpenAI = require('openai');
const patientService = require('./patientService');
const { validateField, ALL_FIELDS, REQUIRED_FIELDS, OPTIONAL_FIELDS } = require('./validators');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/*
 * System prompt / prompt-engineering notes:
 * - Frames the agent as a warm, efficient human intake coordinator (not an IVR).
 * - Explicitly lists required vs optional fields and the exact validation rules from the
 *   spec, so the model self-corrects phrasing ("date of birth" -> MM/DD/YYYY) before ever
 *   calling validate_field.
 * - Forces a tool-mediated workflow: the model must call validate_field for anything it
 *   collects (server-side validation, not just LLM judgment), must call
 *   check_existing_patient once it has a phone number (duplicate-detection bonus), and must
 *   read back the full record and get explicit confirmation before calling
 *   submit_registration. This keeps validation and persistence deterministic instead of
 *   trusting free-form LLM output.
 * - Tells the model how to handle corrections, restarts, and out-of-order answers, since a
 *   real caller rarely answers fields in the order asked.
 */
const SYSTEM_PROMPT = `You are Ava, a warm and efficient human patient-intake coordinator answering an inbound phone call for a medical clinic. You are NOT a robotic IVR menu — speak naturally, in short conversational sentences suitable for text-to-speech (no bullet points, no markdown, no asterisks).

GOAL: Register a new patient by collecting the required demographic fields below, confirm everything back to the caller, then save the record.

REQUIRED FIELDS:
- first_name (letters, hyphens, apostrophes only)
- last_name (letters, hyphens, apostrophes only)
- date_of_birth (a real past date; ask for month, day, and year; never accept a future date)
- sex (Male, Female, Other, or Decline to Answer)
- phone_number (10-digit U.S. phone number — ask for it early so you can check for an existing record)
- address_line_1 (street address)
- city
- state (U.S. state — you can accept full name or abbreviation, but normalize to the 2-letter abbreviation)
- zip_code (5 digits, or ZIP+4)

OPTIONAL FIELDS (offer once required fields are done, do not force them):
- email
- address_line_2 (apartment/suite/unit)
- insurance_provider and insurance_member_id
- preferred_language (default English)
- emergency_contact_name and emergency_contact_phone

CONVERSATION RULES:
1. Greet the caller briefly and explain you'll help them register.
2. Collect required fields conversationally. You do not have to ask in a fixed order — follow the caller's lead, and if they volunteer several fields at once, accept all of them.
3. As soon as you have a candidate value for ANY field, call the validate_field tool before treating it as accepted. If it's invalid, apologize briefly and re-ask ONLY for that specific field, explaining the correct format (e.g. "I need a 10-digit phone number" or "that date of birth appears to be in the future, could you repeat your birth date?").
4. As soon as you have a valid 10-digit phone_number, call check_existing_patient. If it returns an existing patient, tell the caller: "It looks like we already have a record for {first_name} {last_name}. Would you like to update your information instead?" If they say yes, keep collecting corrected/updated fields and finish by calling update_existing_patient instead of submit_registration. If they say no (wrong number / different person), continue as a new registration.
5. Handle corrections gracefully at any point ("actually my last name is spelled D-A-V-I-S") — just re-validate and overwrite that field, no need to restart.
6. If the caller says something like "start over" or "can we restart", discard all previously collected field values and begin the collection again from scratch, and confirm out loud that you've started over.
7. Once all required fields are valid, briefly offer the optional fields in one sentence: "I can also collect your insurance information, emergency contact, and preferred language, would you like to provide any of those?" Respect their answer either way.
8. Before saving, read back EVERY collected field in a natural sentence or two and explicitly ask "Did I get everything right?" Do not call submit_registration or update_existing_patient until the caller confirms.
9. If the caller corrects something during the read-back, update the field (re-validating it) and read back again before saving.
10. After a successful submit_registration or update_existing_patient call, thank the caller by first name, tell them they're all set, and call the end_call tool, then say a brief goodbye.
11. If submit_registration or update_existing_patient returns an error (e.g. a database/validation failure), apologize, tell them there was a technical problem saving their information, and ask if they'd like you to try again — do not pretend it succeeded.
12. Keep every spoken turn short (1-3 sentences). Never read out internal tool names, IDs, or JSON to the caller.
13. If the caller says "Hablo español" or otherwise asks for Spanish, continue the entire conversation in Spanish from that point on (you are fluent), and set preferred_language to Spanish.`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'validate_field',
      description: 'Validate and normalize a single patient field value against server-side rules before accepting it.',
      parameters: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ALL_FIELDS },
          value: { type: 'string', description: 'The raw value as spoken/transcribed from the caller.' }
        },
        required: ['field', 'value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_existing_patient',
      description: 'Look up whether a patient with this phone number already exists in the system.',
      parameters: {
        type: 'object',
        properties: {
          phone_number: { type: 'string' }
        },
        required: ['phone_number']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'submit_registration',
      description: 'Persist a new patient record after the caller has confirmed all details are correct.',
      parameters: {
        type: 'object',
        properties: Object.fromEntries(ALL_FIELDS.map((f) => [f, { type: 'string' }])),
        required: REQUIRED_FIELDS
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_existing_patient',
      description: 'Update an existing patient record (found via check_existing_patient) after the caller confirms the changes.',
      parameters: {
        type: 'object',
        properties: {
          patient_id: { type: 'string' },
          ...Object.fromEntries(ALL_FIELDS.map((f) => [f, { type: 'string' }]))
        },
        required: ['patient_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'end_call',
      description: 'Call this once you have said your final goodbye and the call should be hung up.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

function executeTool(name, args, callState) {
  try {
    switch (name) {
      case 'validate_field': {
        const result = validateField(args.field, args.value);
        return result;
      }
      case 'check_existing_patient': {
        const patient = patientService.findByPhone(args.phone_number);
        if (patient) callState.matchedExistingPatientId = patient.patient_id;
        return { found: !!patient, patient: patient || null };
      }
      case 'submit_registration': {
        const patient = patientService.createPatient(args);
        callState.savedPatientId = patient.patient_id;
        return { success: true, patient };
      }
      case 'update_existing_patient': {
        const { patient_id, ...fields } = args;
        const patient = patientService.updatePatient(patient_id, fields);
        callState.savedPatientId = patient.patient_id;
        return { success: true, patient };
      }
      case 'end_call': {
        callState.shouldHangup = true;
        return { ok: true };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    console.error(`[llmAgent] Tool ${name} failed:`, err.message);
    if (err.name === 'ValidationError') {
      return { success: false, error: 'validation_failed', fields: err.errors };
    }
    return { success: false, error: 'internal_error', message: err.message };
  }
}

function createCallState() {
  return {
    messages: [{ role: 'system', content: SYSTEM_PROMPT }],
    shouldHangup: false,
    matchedExistingPatientId: null,
    savedPatientId: null,
    transcript: []
  };
}

// Runs one turn: optionally appends a user utterance, then loops tool calls until the model
// produces plain text to speak. Returns { say, hangup }.
async function runTurn(callState, userText) {
  if (userText) {
    callState.messages.push({ role: 'user', content: userText });
    callState.transcript.push({ role: 'caller', text: userText });
  }

  const MAX_TOOL_ITERATIONS = 6;
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: callState.messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.4
    });

    const choice = response.choices[0];
    const message = choice.message;
    callState.messages.push(message);

    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments || '{}');
        } catch (e) {
          args = {};
        }
        const result = executeTool(toolCall.function.name, args, callState);
        callState.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }
      continue; // let the model react to tool results
    }

    const say = (message.content || "I'm sorry, could you repeat that?").trim();
    callState.transcript.push({ role: 'agent', text: say });
    return { say, hangup: callState.shouldHangup };
  }

  return {
    say: "I'm having trouble processing that right now. Let's try again — could you repeat your last answer?",
    hangup: false
  };
}

module.exports = { createCallState, runTurn };
