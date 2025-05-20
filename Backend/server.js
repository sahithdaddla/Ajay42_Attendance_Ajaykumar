
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const winston = require('winston');
const cors = require('cors'); // Add CORS package
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3019;

// Logger setup
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'server.log' }),
        new winston.transports.Console()
    ]
});

// PostgreSQL connection
const pool = new Pool({
   user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'postgres',
    database: process.env.DB_NAME || 'attendance_db',
    password: process.env.DB_PASSWORD || 'admin123',
    port: process.env.DB_PORT || 5432,
});

// Middleware
app.use(cors());
app.use(cors({
    origin: ['http://54.166.206.245:3018, 'http://127.0.0.1:5501'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.url}`, { body: req.body });
    next();
});

// Initialize database
async function initializeDatabase() {
    try {
        const client = await pool.connect();
        await client.query(`
    DROP TABLE IF EXISTS assets;
    DROP TABLE IF EXISTS attendance;
    DROP TABLE IF EXISTS employees;
`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS employees (
                emp_id VARCHAR(7) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50),
                shift_timing VARCHAR(50)
            );

            CREATE TABLE IF NOT EXISTS attendance (
                id SERIAL PRIMARY KEY,
                emp_id VARCHAR(7) NOT NULL,
                punch_in TIMESTAMP NOT NULL,
                punch_out TIMESTAMP,
                status VARCHAR(20) DEFAULT 'in-progress',
                punch_in_password VARCHAR(255),
                punch_out_password VARCHAR(255)
            );

            CREATE TABLE IF NOT EXISTS assets (
                id SERIAL PRIMARY KEY,
                emp_id VARCHAR(7) NOT NULL,
                asset_type VARCHAR(50) NOT NULL,
                request_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status VARCHAR(20) DEFAULT 'pending'
            );
        `);
        await client.query(`
            INSERT INTO employees (emp_id, name, email, password, role, shift_timing)
            VALUES 
                ('ATS0123', 'Employee One', 'employee1@company.com', '${await bcrypt.hash('password123', 10)}', 'Developer', '10:00 AM - 7:00 PM'),
                ('ATS0456', 'Employee Two', 'employee2@company.com', '${await bcrypt.hash('password456', 10)}', 'Designer', '10:00 AM - 7:00 PM')
            ON CONFLICT (emp_id) DO NOTHING;
        `);
        client.release();
        logger.info('Database initialized successfully');
    } catch (err) {
        logger.error('Database initialization failed', { error: err.message });
    }
}

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Validate employee credentials
app.post('/api/auth/validate', async (req, res) => {
    const { empId, password } = req.body;
    if (!empId || !password) {
        return res.status(400).json({ error: 'Employee ID and password are required' });
    }
    try {
        const result = await pool.query('SELECT * FROM employees WHERE emp_id = $1', [empId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Employee not found' });
        }
        const employee = result.rows[0];
        const isMatch = await bcrypt.compare(password, employee.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid password' });
        }
        res.status(200).json({ message: 'Validation successful', empId });
    } catch (err) {
        logger.error('Validation error', { error: err.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Punch in
app.post('/api/attendance/punch-in', async (req, res) => {
    const { empId, password } = req.body;
    if (!empId || !password) {
        return res.status(400).json({ error: 'Employee ID and password are required' });
    }
    if (!/^ATS0[1-9][0-9]{2}$/.test(empId)) {
        return res.status(400).json({ error: 'Invalid Employee ID format' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
        const openPunch = await pool.query(
            'SELECT * FROM attendance WHERE emp_id = $1 AND punch_out IS NULL ORDER BY punch_in DESC LIMIT 1',
            [empId]
        );
        if (openPunch.rows.length > 0) {
            const punchInTime = new Date(openPunch.rows[0].punch_in);
            const now = new Date();
            const hoursSincePunchIn = (now - punchInTime) / (1000 * 60 * 60);
            if (hoursSincePunchIn >= 12) {
                logger.info(`Auto-punched out for emp_id: ${empId} after 12 hours`);
                await pool.query(
                    'UPDATE attendance SET punch_out = $1, status = $2, punch_out_password = $3 WHERE id = $4',
                    [now, 'not-defined', null, openPunch.rows[0].id]
                );
            } else {
                return res.status(400).json({
                    error: 'You are already punched in. Please punch out first.',
                    alreadyPunchedIn: true,
                    record: openPunch.rows[0]
                });
            }
        }

        const employeeCheck = await pool.query('SELECT * FROM employees WHERE emp_id = $1', [empId]);
        const isNewEmployee = employeeCheck.rows.length === 0;
        const status = isNewEmployee ? 'pending' : 'in-progress';
        const hashedPassword = await bcrypt.hash(password, 10);

        const result = await pool.query(
            'INSERT INTO attendance (emp_id, punch_in, status, punch_in_password) VALUES ($1, $2, $3, $4) RETURNING *',
            [empId, new Date(), status, hashedPassword]
        );

        const message = isNewEmployee
            ? 'Punch-in recorded, pending HR approval'
            : 'Punch-in recorded';
        res.status(200).json({ message, record: result.rows[0] });
    } catch (err) {
        logger.error('Punch-in error', { error: err.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Punch out
app.post('/api/attendance/punch-out', async (req, res) => {
    const { empId, password } = req.body;
    if (!empId || !password) {
        return res.status(400).json({ error: 'Employee ID and password are required' });
    }
    if (!/^ATS0[1-9][0-9]{2}$/.test(empId)) {
        return res.status(400).json({ error: 'Invalid Employee ID format' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
        const openPunch = await pool.query(
            'SELECT * FROM attendance WHERE emp_id = $1 AND punch_out IS NULL ORDER BY punch_in DESC LIMIT 1',
            [empId]
        );
        if (openPunch.rows.length === 0) {
            return res.status(400).json({ error: 'No open punch-in found' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const status = openPunch.rows[0].status === 'pending' ? 'pending' : 'full-day';

        const result = await pool.query(
            'UPDATE attendance SET punch_out = $1, status = $2, punch_out_password = $3 WHERE id = $4 RETURNING *',
            [new Date(), status, hashedPassword, openPunch.rows[0].id]
        );

        const message = openPunch.rows[0].status === 'pending'
            ? 'Punch-out recorded, pending HR approval'
            : 'Punch-out recorded';
        res.status(200).json({ message, record: result.rows[0] });
    } catch (err) {
        logger.error('Punch-out error', { error: err.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get attendance records
app.get('/api/attendance/:empId', async (req, res) => {
    const { empId } = req.params;
    if (!/^ATS0[1-9][0-9]{2}$/.test(empId)) {
        return res.status(400).json({ error: 'Invalid Employee ID format' });
    }
    try {
        const result = await pool.query(
            'SELECT * FROM attendance WHERE emp_id = $1 ORDER BY punch_in DESC',
            [empId]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        logger.error('Fetch attendance error', { error: err.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get employee data
app.get('/api/employee/:empId', async (req, res) => {
    const { empId } = req.params;
    if (!/^ATS0[1-9][0-9]{2}$/.test(empId)) {
        return res.status(400).json({ error: 'Invalid Employee ID format' });
    }
    try {
        const result = await pool.query('SELECT emp_id, name, email, role, shift_timing FROM employees WHERE emp_id = $1', [empId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Employee not found' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        logger.error('Fetch employee error', { error: err.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start server
pool.connect()
    .then(() => {
        logger.info(`Database connection successful: ${new Date().toISOString()}`);
        initializeDatabase().then(() => {
           app.listen(port, '0.0.0.0', () => {
                logger.info(`Server running on port ${port}`);
                console.log(`Health check: http://54.166.206.245:${port}/health`);
                console.log(`HR Dashboard: http://54.166.206.245:${port}/attendance.html`);
                console.log(`Employee Asset Request: http://54.166.206.245:${port}/employee.html`);
            });
        });
    })
    .catch(err => {
        logger.error('Database connection failed', { error: err.message });
        process.exit(1);
    });
