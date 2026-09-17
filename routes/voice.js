const express = require('express');
const twilio = require('twilio');
const router = express.Router();
const llmAgent = require('./../services/llmAgent');
const patientService = require('./../services/patientService');

// In-memory conversation state keyed by CallSid. Fine for a single-instance demo deployment;
// see README "Known Limitations" for how this would need to change for multi-instance hosting.
const callStates = new Map();

const VOICE = process.env.TWILIO_TTS_VOICE || 'Polly.Joanna';
const GATHER_TIMEOUT_MESSAGE = "I didn't catch that. Are you still there?";

function buildGatherResponse({ say, hangup }) {
  const twiml = new twilio.twiml.VoiceResponse();

  if (hangup) {
    twiml.say({ voice: VOICE }, say);
    twiml.hangup();
    return twiml;
  }

  const gather = twiml.gather({
    input: 'speech',
    action: '/voice/gather',
    method: 'POST',
    speechTimeout: 'auto',
    speechModel: 'phone_call'
  });
  gather.say({ voice: VOICE }, say);

  // If Gather gets no speech at all, Twilio falls through here.
  twiml.say({ voice: VOICE }, GATHER_TIMEOUT_MESSAGE);
  twiml.redirect({ method: 'POST' }, '/voice/incoming?retry=1');

  return twiml;
}

// Entry point for inbound calls
router.post('/incoming', async (req, res) => {
  const callSid = req.body.CallSid;
  console.log(`[voice] Incoming call ${callSid} from ${req.body.From}`);

  let state = callStates.get(callSid);
  if (!state) {
    state = llmAgent.createCallState();
    callStates.set(callSid, state);
  }

  try {
    const isRetry = req.query.retry === '1';
    const kickoff = isRetry
      ? 'The caller did not respond. Gently check if they are still on the line and continue helping them register.'
      : 'The call just started. Greet the caller warmly, introduce yourself as the intake assistant, and ask how you can help (registering as a new patient).';

    const { say, hangup } = await llmAgent.runTurn(state, kickoff);
    const twiml = buildGatherResponse({ say, hangup });
    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('[voice/incoming] error:', err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: VOICE }, "I'm sorry, we're experiencing a technical issue. Please call back in a few minutes.");
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

// Handles each turn of speech input
router.post('/gather', async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  console.log(`[voice] ${callSid} said: "${speechResult}"`);

  let state = callStates.get(callSid);
  if (!state) {
    state = llmAgent.createCallState();
    callStates.set(callSid, state);
  }

  try {
    const { say, hangup } = await llmAgent.runTurn(state, speechResult || '(no speech detected, please re-prompt)');
    const twiml = buildGatherResponse({ say, hangup });
    res.type('text/xml').send(twiml.toString());

    if (hangup) {
      finalizeCall(callSid, state);
    }
  } catch (err) {
    console.error('[voice/gather] error:', err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: VOICE }, "I'm sorry, something went wrong on our end saving your information. Please try calling back shortly.");
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
    finalizeCall(callSid, state);
  }
});

// Call status callback (completed, failed, busy, no-answer) - cleans up state on drop/hangup
router.post('/status', (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  console.log(`[voice/status] ${callSid} -> ${callStatus}`);

  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(callStatus)) {
    const state = callStates.get(callSid);
    if (state) {
      finalizeCall(callSid, state);
    }
  }
  res.status(200).send('OK');
});

function finalizeCall(callSid, state) {
  try {
    if (state.transcript.length > 0) {
      const transcriptText = state.transcript.map((t) => `${t.role}: ${t.text}`).join('\n');
      patientService.saveTranscript({
        callSid,
        patientId: state.savedPatientId,
        transcript: transcriptText
      });
      console.log(`[voice] Call ${callSid} final payload:`, JSON.stringify({
        patientId: state.savedPatientId,
        matchedExistingPatientId: state.matchedExistingPatientId
      }));
    }
  } catch (err) {
    console.error('[voice] Failed to persist transcript:', err);
  } finally {
    callStates.delete(callSid);
  }
}

module.exports = router;
