const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const winston = require('winston');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3427;

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
    database: process.env.DB_NAME || 'new_employee_db',
    password: process.env.DB_PASSWORD || 'admin123',
    port: process.env.DB_PORT || 5432,
});

// Middleware
app.use(cors({
    origin: ['http://44.223.23.145:8050','http://44.223.23.145:8051','http://44.223.23.145:3427', 'http://localhost:3019', 'http://127.0.0.1:5501', 'http://127.0.0.1:5503'],
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
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
                role VARCHAR(50),
                shift_timing VARCHAR(50)
            );

            CREATE TABLE IF NOT EXISTS attendance (
                id SERIAL PRIMARY KEY,
                emp_id VARCHAR(7) NOT NULL,
                punch_in TIMESTAMP NOT NULL,
                punch_out TIMESTAMP,
                status VARCHAR(20) DEFAULT 'in-progress',
                hr_approval VARCHAR(20) DEFAULT 'pending'
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
            INSERT INTO employees (emp_id, name, email, role, shift_timing)
            VALUES 
                ('ATS0123', 'Employee One', 'employee1@company.com', 'Developer', '10:00 AM - 7:00 PM'),
                ('ATS0456', 'Employee Two', 'employee2@company.com', 'Designer', '10:00 AM - 7:00 PM')
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
    const { empId } = req.body;
    if (!empId) {
        return res.status(400).json({ error: 'Employee ID is required' });
    }
    if (!/^ATS0[1-9][0-9]{2}$/.test(empId)) {
        return res.status(400).json({ error: 'Invalid Employee ID format' });
    }
    try {
        const result = await pool.query('SELECT * FROM employees WHERE emp_id = $1', [empId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Employee not found', isNewEmployee: true });
        }
        res.status(200).json({ message: 'Validation successful', empId, isNewEmployee: false });
    } catch (err) {
        logger.error('Validation error', { error: err.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Punch in
app.post('/api/attendance/punch-in', async (req, res) => {
    const { empId } = req.body;
    if (!empId) {
        return res.status(400).json({ error: 'Employee ID is required' });
    }
    if (!/^ATS0[1-9][0-9]{2}$/.test(empId)) {
        return res.status(400).json({ error: 'Invalid Employee ID format' });
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
                    'UPDATE attendance SET punch_out = $1, status = $2 WHERE id = $3',
                    [null, 'not-defined', openPunch.rows[0].id]
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

        const result = await pool.query(
            'INSERT INTO attendance (emp_id, punch_in, status, hr_approval) VALUES ($1, $2, $3, $4) RETURNING *',
            [empId, new Date(), status, 'pending']
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
    const { empId } = req.body;
    if (!empId) {
        return res.status(400).json({ error: 'Employee ID is required' });
    }
    if (!/^ATS0[1-9][0-9]{2}$/.test(empId)) {
        return res.status(400).json({ error: 'Invalid Employee ID format' });
    }

    try {
        const openPunch = await pool.query(
            'SELECT * FROM attendance WHERE emp_id = $1 AND punch_out IS NULL ORDER BY punch_in DESC LIMIT 1',
            [empId]
        );
        if (openPunch.rows.length === 0) {
            return res.status(400).json({ error: 'No open punch-in found' });
        }

        const status = openPunch.rows[0].status === 'pending' ? 'pending' : 'full-day';

        const result = await pool.query(
            'UPDATE attendance SET punch_out = $1, status = $2, hr_approval = $3 WHERE id = $4 RETURNING *',
            [new Date(), status, 'pending', openPunch.rows[0].id]
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

// Get all attendance records for a specific date
app.get('/api/attendance/all', async (req, res) => {
    const { date } = req.query;
    let query = 'SELECT * FROM attendance ORDER BY punch_in DESC';
    let queryParams = [];

    if (date) {
        const selectedDate = new Date(date);
        const startOfDay = new Date(selectedDate.setHours(0, 0, 0, 0));
        const endOfDay = new Date(selectedDate.setHours(23, 59, 59, 999));
        query = 'SELECT * FROM attendance WHERE punch_in >= $1 AND punch_in <= $2 ORDER BY punch_in DESC';
        queryParams = [startOfDay, endOfDay];
    } else {
        const today = new Date();
        const startOfDay = new Date(today.setHours(0, 0, 0, 0));
        const endOfDay = new Date(today.setHours(23, 59, 59, 999));
        query = 'SELECT * FROM attendance WHERE punch_in >= $1 AND punch_in <= $2 ORDER BY punch_in DESC';
        queryParams = [startOfDay, endOfDay];
    }

    try {
        const result = await pool.query(query, queryParams);
        res.status(200).json(result.rows);
    } catch (err) {
        logger.error('Fetch all attendance error', { error: err.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get attendance records for an employee
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

// Approve attendance
app.put('/api/attendance/approve/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const record = await pool.query('SELECT * FROM attendance WHERE id = $1', [id]);
        if (record.rows.length === 0) {
            return res.status(404).json({ error: 'Attendance record not found' });
        }
        if (record.rows[0].punch_out === null && record.rows[0].status !== 'not-defined') {
            return res.status(400).json({ error: 'Cannot approve record without punch-out' });
        }
        await pool.query('UPDATE attendance SET hr_approval = $1 WHERE id = $2', ['approved', id]);
        res.status(200).json({ message: 'Attendance approved' });
    } catch (err) {
        logger.error('Approve attendance error', { error: err.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Reject attendance
app.put('/api/attendance/reject/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const record = await pool.query('SELECT * FROM attendance WHERE id = $1', [id]);
        if (record.rows.length === 0) {
            return res.status(404).json({ error: 'Attendance record not found' });
        }
        if (record.rows[0].punch_out === null && record.rows[0].status !== 'not-defined') {
            return res.status(400).json({ error: 'Cannot reject record without punch-out' });
        }
        await pool.query('UPDATE attendance SET hr_approval = $1 WHERE id = $2', ['rejected', id]);
        res.status(200).json({ message: 'Attendance rejected' });
    } catch (err) {
        logger.error('Reject attendance error', { error: err.message });
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
                console.log(`Health check: http://44.223.23.145:${port}/health`);
                console.log(`HR Dashboard: http://44.223.23.145:${port}/attendance.html`);
                console.log(`Employee Attendance: http://44.223.23.145:${port}/employee_attendance.html`);
            });
        });
    })
    .catch(err => {
        logger.error('Database connection failed', { error: err.message });
        process.exit(1);
    });
