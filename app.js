class PhoneDialer {
    constructor() {
        this.phoneNumberInput = document.getElementById('phoneNumber');
        this.statusDiv = document.getElementById('status');
        this.callBtn = document.getElementById('callBtn');
        this.hangupBtn = document.getElementById('hangupBtn');
        this.clearBtn = document.getElementById('clearBtn');
        this.setupBtn = document.getElementById('setupBtn');
        
        this.device = null;
        this.currentCall = null;
        this.isConnected = false;
        
        this.initializeEventListeners();
        this.loadStoredConfig();
    }
    
    initializeEventListeners() {
        // Keypad buttons
        document.querySelectorAll('.key').forEach(key => {
            key.addEventListener('click', (e) => {
                const number = e.target.getAttribute('data-number');
                this.addDigit(number);
            });
        });
        
        // Control buttons
        this.callBtn.addEventListener('click', () => this.makeCall());
        this.hangupBtn.addEventListener('click', () => this.hangupCall());
        this.clearBtn.addEventListener('click', () => this.clearNumber());
        this.setupBtn.addEventListener('click', () => this.setupTwilio());
        
        // Keyboard support
        document.addEventListener('keydown', (e) => {
            if (e.key >= '0' && e.key <= '9' || e.key === '*' || e.key === '#') {
                this.addDigit(e.key);
            } else if (e.key === 'Backspace') {
                this.removeLastDigit();
            } else if (e.key === 'Enter') {
                this.makeCall();
            } else if (e.key === 'Escape') {
                this.clearNumber();
            }
        });
    }
    
    addDigit(digit) {
        const currentNumber = this.phoneNumberInput.value;
        this.phoneNumberInput.value = currentNumber + digit;
    }
    
    removeLastDigit() {
        const currentNumber = this.phoneNumberInput.value;
        this.phoneNumberInput.value = currentNumber.slice(0, -1);
    }
    
    clearNumber() {
        this.phoneNumberInput.value = '';
    }
    
    updateStatus(message, type = '') {
        this.statusDiv.textContent = message;
        this.statusDiv.className = 'status ' + type;
    }
    
    async setupTwilio() {
        const accountSid = document.getElementById('accountSid').value;
        const authToken = document.getElementById('authToken').value;
        
        if (!accountSid || !authToken) {
            this.updateStatus('Please enter Account SID and Auth Token', 'error');
            return;
        }
        
        try {
            // Store credentials (in production, use secure storage)
            localStorage.setItem('twilioAccountSid', accountSid);
            localStorage.setItem('twilioAuthToken', authToken);
            
            // Get access token from backend
            const response = await fetch('/api/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    accountSid: accountSid,
                    authToken: authToken
                })
            });
            
            if (!response.ok) {
                throw new Error('Failed to get access token');
            }
            
            const data = await response.json();
            await this.initializeTwilioDevice(data.token);
            
        } catch (error) {
            console.error('Setup error:', error);
            this.updateStatus('Setup failed. Using demo mode.', 'error');
            this.initializeDemoMode();
        }
    }
    
    async initializeTwilioDevice(token) {
        try {
            this.device = new Twilio.Device(token);
            
            this.device.on('ready', () => {
                this.isConnected = true;
                this.updateStatus('Connected to Twilio', 'connected');
                this.callBtn.disabled = false;
            });
            
            this.device.on('error', (error) => {
                console.error('Twilio Device Error:', error);
                this.updateStatus('Connection error', 'error');
            });
            
            this.device.on('connect', (call) => {
                this.currentCall = call;
                this.updateStatus('Call connected', 'connected');
                this.callBtn.style.display = 'none';
                this.hangupBtn.style.display = 'block';
            });
            
            this.device.on('disconnect', () => {
                this.currentCall = null;
                this.updateStatus('Call ended', '');
                this.callBtn.style.display = 'block';
                this.hangupBtn.style.display = 'none';
            });
            
            await this.device.setup();
            
        } catch (error) {
            console.error('Device initialization error:', error);
            this.updateStatus('Failed to initialize device', 'error');
        }
    }
    
    initializeDemoMode() {
        this.updateStatus('Demo mode - calls will be simulated', '');
        this.callBtn.disabled = false;
    }
    
    loadStoredConfig() {
        const accountSid = localStorage.getItem('twilioAccountSid');
        const authToken = localStorage.getItem('twilioAuthToken');
        
        if (accountSid) {
            document.getElementById('accountSid').value = accountSid;
        }
        if (authToken) {
            document.getElementById('authToken').value = authToken;
        }
        
        // Auto-setup if credentials are available
        if (accountSid && authToken) {
            this.setupTwilio();
        } else {
            this.initializeDemoMode();
        }
    }
    
    makeCall() {
        const phoneNumber = this.phoneNumberInput.value.trim();
        
        if (!phoneNumber) {
            this.updateStatus('Please enter a phone number', 'error');
            return;
        }
        
        // Validate phone number format
        if (!this.isValidPhoneNumber(phoneNumber)) {
            this.updateStatus('Please enter a valid phone number', 'error');
            return;
        }
        
        if (this.device && this.isConnected) {
            try {
                this.updateStatus('Calling...', 'calling');
                const call = this.device.connect({
                    To: phoneNumber
                });
                
                call.on('accept', () => {
                    this.updateStatus('Call connected', 'connected');
                });
                
                call.on('cancel', () => {
                    this.updateStatus('Call cancelled', '');
                });
                
                call.on('disconnect', () => {
                    this.updateStatus('Call ended', '');
                    this.callBtn.style.display = 'block';
                    this.hangupBtn.style.display = 'none';
                });
                
            } catch (error) {
                console.error('Call error:', error);
                this.updateStatus('Failed to make call', 'error');
            }
        } else {
            // Demo mode simulation
            this.simulateCall(phoneNumber);
        }
    }
    
    simulateCall(phoneNumber) {
        this.updateStatus('Calling ' + phoneNumber + '...', 'calling');
        this.callBtn.style.display = 'none';
        this.hangupBtn.style.display = 'block';
        
        // Simulate call connection after 2 seconds
        setTimeout(() => {
            this.updateStatus('Demo call connected to ' + phoneNumber, 'connected');
        }, 2000);
    }
    
    hangupCall() {
        if (this.currentCall) {
            this.currentCall.disconnect();
        } else {
            // Demo mode
            this.updateStatus('Call ended', '');
            this.callBtn.style.display = 'block';
            this.hangupBtn.style.display = 'none';
        }
    }
    
    isValidPhoneNumber(phoneNumber) {
        // Basic phone number validation
        // Remove all non-digit characters except + at the beginning
        const cleaned = phoneNumber.replace(/[^\d+]/g, '');
        
        // Check if it starts with + and has 10-15 digits, or just has 10+ digits
        return /^\+\d{10,15}$/.test(cleaned) || /^\d{10,}$/.test(cleaned);
    }
    
    formatPhoneNumber(phoneNumber) {
        // Format phone number for display
        const cleaned = phoneNumber.replace(/\D/g, '');
        
        if (cleaned.length === 10) {
            return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
        } else if (cleaned.length === 11 && cleaned[0] === '1') {
            return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
        }
        
        return phoneNumber;
    }
}

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new PhoneDialer();
});

// Service Worker for PWA functionality (optional)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then((registration) => {
                console.log('SW registered: ', registration);
            })
            .catch((registrationError) => {
                console.log('SW registration failed: ', registrationError);
            });
    });
}
