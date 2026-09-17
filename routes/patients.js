const express = require('express');
const router = express.Router();
const patientService = require('../services/patientService');

function envelope(data, error = null) {
  return { data, error };
}

// GET /patients?last_name=&date_of_birth=&phone_number=
router.get('/', (req, res) => {
  try {
    const { last_name, date_of_birth, phone_number } = req.query;
    const patients = patientService.listPatients({ last_name, date_of_birth, phone_number });
    res.status(200).json(envelope(patients));
  } catch (err) {
    console.error('[GET /patients] error:', err);
    res.status(500).json(envelope(null, 'Internal server error'));
  }
});

// GET /patients/:id
router.get('/:id', (req, res) => {
  try {
    const patient = patientService.getPatientById(req.params.id);
    if (!patient) return res.status(404).json(envelope(null, 'Patient not found'));
    res.status(200).json(envelope(patient));
  } catch (err) {
    console.error('[GET /patients/:id] error:', err);
    res.status(500).json(envelope(null, 'Internal server error'));
  }
});

// POST /patients
router.post('/', (req, res) => {
  try {
    const patient = patientService.createPatient(req.body || {});
    res.status(201).json(envelope(patient));
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(422).json(envelope(null, { message: 'Validation failed', fields: err.errors }));
    }
    console.error('[POST /patients] error:', err);
    res.status(500).json(envelope(null, 'Internal server error'));
  }
});

// PUT /patients/:id
router.put('/:id', (req, res) => {
  try {
    const patient = patientService.updatePatient(req.params.id, req.body || {});
    res.status(200).json(envelope(patient));
  } catch (err) {
    if (err.name === 'NotFoundError') {
      return res.status(404).json(envelope(null, 'Patient not found'));
    }
    if (err.name === 'ValidationError') {
      return res.status(422).json(envelope(null, { message: 'Validation failed', fields: err.errors }));
    }
    console.error('[PUT /patients/:id] error:', err);
    res.status(500).json(envelope(null, 'Internal server error'));
  }
});

// DELETE /patients/:id (soft delete)
router.delete('/:id', (req, res) => {
  try {
    patientService.softDeletePatient(req.params.id);
    res.status(200).json(envelope({ deleted: true }));
  } catch (err) {
    if (err.name === 'NotFoundError') {
      return res.status(404).json(envelope(null, 'Patient not found'));
    }
    console.error('[DELETE /patients/:id] error:', err);
    res.status(500).json(envelope(null, 'Internal server error'));
  }
});

module.exports = router;
