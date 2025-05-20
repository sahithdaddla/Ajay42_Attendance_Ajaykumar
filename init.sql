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
