const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

require('./db/database'); // initializes schema + seed data on startup

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true })); // Twilio webhooks post form-encoded bodies

// Basic request logging for observability
app.use((req, res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.use('/patients', require('./routes/patients'));
app.use('/voice', require('./routes/voice'));

app.get('/health', (req, res) => res.status(200).json({ data: { status: 'ok' }, error: null }));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ data: null, error: 'Not found' });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ data: null, error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Voice AI patient registration server running on port ${port}`);
  console.log(`Dashboard: http://localhost:${port}`);
  console.log(`REST API:  http://localhost:${port}/patients`);
  console.log(`Twilio voice webhook: POST http://localhost:${port}/voice/incoming`);
});

module.exports = app;
