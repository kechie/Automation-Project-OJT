from flask import Flask, request, jsonify, send_from_directory, session
import sqlite3
import os
import json
from datetime import datetime, timedelta, timezone
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', os.urandom(24).hex())
app.permanent_session_lifetime = timedelta(hours=8)
DB_PATH = os.path.join(
    os.environ.get('LOCALAPPDATA', os.path.expanduser('~\\AppData\\Local')),
    'OJT-automation', 'database.db'
)

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=5000')
    return conn 

def init_db():
    _old_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'database.db')
    if os.path.exists(_old_path) and not os.path.exists(DB_PATH):
        try:
            os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
            import shutil
            shutil.copy2(_old_path, DB_PATH)
        except Exception:
            pass
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS reports (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 office_id TEXT NOT NULL,
                 office_name TEXT NOT NULL,
                 quarter TEXT NOT NULL,
                 year INTEGER NOT NULL, 
                 report_type TEXT NOT NULL,
                 status TEXT NOT NULL,
                 submitted_at TEXT NOT NULL,
                 data TEXT NOT NULL             
        )
    ''')
    conn.execute('''CREATE TABLE IF NOT EXISTS users (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 office_id TEXT NOT NULL, 
                 role TEXT NOT NULL,
                 password NOT NULL             
    )
''')
    conn.execute('''CREATE TABLE IF NOT EXISTS offices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
    )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS programs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        office_id TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        year INTEGER NOT NULL DEFAULT 0,
        aip_ps REAL DEFAULT 0,
        aip_mooe REAL DEFAULT 0,
        aip_co REAL DEFAULT 0,
        budget_ps REAL DEFAULT 0,
        budget_mooe REAL DEFAULT 0,
        budget_co REAL DEFAULT 0,
        budget_total REAL DEFAULT 0,
        mfo TEXT DEFAULT '',
        performance_indicator TEXT DEFAULT ''
    )''')
    try:
        conn.execute('ALTER TABLE programs ADD COLUMN year INTEGER NOT NULL DEFAULT 0')
    except:
        pass
    conn.execute('UPDATE programs SET year = ? WHERE year = 0', (datetime.now().year,))
    conn.execute('''
        CREATE TABLE IF NOT EXISTS aip (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            office_id TEXT NOT NULL,
            office_name TEXT NOT NULL,
            year INTEGER NOT NULL,
            status TEXT NOT NULL,
            submitted_at TEXT NOT NULL,
            data TEXT NOT NULL
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS global_deadlines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            year INTEGER NOT NULL,
            deadline_at TEXT NOT NULL,
            UNIQUE(year)
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS submission_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            office_id TEXT NOT NULL,
            office_name TEXT NOT NULL,
            year INTEGER NOT NULL,
            report_type TEXT NOT NULL DEFAULT '',
            quarter TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            requested_at TEXT NOT NULL,
            reviewed_at TEXT,
            reviewer_notes TEXT DEFAULT ''
        )
    ''')
    conn.commit()
    conn.close()

def seed_programs():
    conn = get_db()
    current_year = datetime.now().year
    try:
        with open('office-data.generated.js', 'r') as f:
            content = f.read()
        match = __import__('re').search(r'const OFFICE_DATA = (\[.*?\]);', content, __import__('re').DOTALL)
        if match:
            data = json.loads(match.group(1))
            # Seed offices (always, INSERT OR IGNORE is idempotent)
            for office in data:
                conn.execute('INSERT OR IGNORE INTO offices (id, name) VALUES (?, ?)',
                             (office['id'], office['name']))
            # Only seed programs if none exist for current year
            existing = conn.execute('SELECT COUNT(*) as cnt FROM programs WHERE year = ?', (current_year,)).fetchone()
            if existing and existing['cnt'] > 0:
                conn.close()
                return
            for office in data:
                for prog in office.get('programs', []):
                    conn.execute('''INSERT INTO programs 
                        (office_id, code, name, year, aip_ps, aip_mooe, aip_co,
                         budget_ps, budget_mooe, budget_co, budget_total,
                         mfo, performance_indicator)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                        (office['id'], prog.get('code',''), prog.get('name',''), current_year,
                         prog.get('aipAmount',{}).get('ps',0),
                         prog.get('aipAmount',{}).get('mooe',0),
                         prog.get('aipAmount',{}).get('co',0),
                         prog.get('annualBudget',{}).get('ps',0),
                         prog.get('annualBudget',{}).get('mooe',0),
                         prog.get('annualBudget',{}).get('co',0),
                         prog.get('annualBudget',{}).get('total',0),
                         prog.get('mfo',''), prog.get('performanceIndicator','')))
            conn.commit()
    except Exception as e:
        print('Seed error:', e)
    finally:
        conn.close()

@app.route('/')

def index(): 
    return send_from_directory('.', 'index.html')

@app.route('/<path:filename>')
def static_files(filename): 
    if '..' in filename or filename.startswith('/') or filename.startswith('\\'):
        return 'Forbidden', 403
    allowed_ext = ('.html', '.js', '.css', '.ico', '.png', '.jpg', '.svg', '.json', '.txt')
    if not filename.lower().endswith(allowed_ext):
        return 'Forbidden', 403
    return send_from_directory('.', filename)

@app.route('/api/submit', methods=['POST'])
def submit_report(): 
    body = request.get_json()
    office_id = body['office']
    report_type = body.get('report_type', 'quarterly')
    quarter = body.get('quarter', '')
    year = body.get('year', datetime.now().year)
    
    if is_past_deadline(office_id, year):
        return jsonify({'success': False, 'error': 'locked', 'message': 'Submission deadline has passed for this office.'}), 403
    
    conn = get_db()
    existing = conn.execute('''
                            SELECT id FROM reports 
                            WHERE office_id = ? AND quarter = ? AND report_type = ? AND year = ?                            
''', (
    office_id,
    quarter,
    report_type,
    year
)).fetchone()
    
    if existing:
        conn.execute('''
                     UPDATE reports 
                     SET status = ?, submitted_at = ?, data = ?
                     WHERE id = ?
                     ''', (
                         'submitted',
                         body['submittedAt'],
                         json.dumps(body),
                         existing['id']
                     ))
    else:
        conn.execute('''
                     INSERT INTO reports (office_id, office_name, quarter, year, report_type, status, submitted_at, data)
                     VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                     ''', (
                         body['office'],
                         body['officeName'],
                         body.get('quarter', ''),
                         body.get('year', datetime.now().year),
                         body.get('report_type', 'quarterly'),
                        'submitted',
                        body['submittedAt'],
                        json.dumps(body)
                     ))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/reports', methods=['GET'])
def get_reports():
    quarter = request.args.get('quarter', '')
    report_type = request.args.get('type', 'quarterly')
    year = request.args.get('year', datetime.now().year)
    conn = get_db()
    if quarter:
        rows = conn.execute('''
                            SELECT office_id, office_name, submitted_at
                            FROM reports 
                            WHERE quarter = ? AND report_type = ? AND year = ?
        ''', (quarter, report_type, year)).fetchall()
    else:
        rows = conn.execute('''
                            SELECT office_id, office_name, submitted_at
                            FROM reports 
                            WHERE report_type = ? AND year = ?
        ''', (report_type, year)).fetchall()
    conn.close()
    return jsonify([dict(row) for row in rows])

@app.route('/api/reports/<office_id>', methods=['GET'])
def get_report_details(office_id):
    quarter = request.args.get('quarter', '')
    report_type = request.args.get('type', 'quarterly')
    year = request.args.get('year', datetime.now().year)
    conn = get_db()
    if quarter:
        row = conn.execute('''
                           SELECT * FROM reports
                           WHERE office_id = ? AND quarter = ? AND report_type = ? AND year = ?
        ''', (office_id, quarter, report_type, year)).fetchone()
    else:
        row = conn.execute('''
                           SELECT * FROM reports
                           WHERE office_id = ? AND report_type = ? AND year = ?
        ''', (office_id, report_type, year)).fetchone()
    conn.close()
    if row: 
        return jsonify(json.loads(row['data']))
    return jsonify({'error': 'not found'}), 404

@app.route('/api/reports/<office_id>', methods=['PUT'])
def update_report(office_id):
    body = request.get_json()
    quarter = body.get('quarter', '')
    report_type = body.get('report_type', 'quarterly')
    year = body.get('year', datetime.now().year)

    conn = get_db()
    existing = conn.execute('''
        SELECT id FROM reports
        WHERE office_id = ? AND quarter = ? AND report_type = ? AND year = ?
    ''', (office_id, quarter, report_type, year)).fetchone()

    if existing:
        conn.execute('''
            UPDATE reports SET data = ?, submitted_at = ?, status = ?
            WHERE id = ?
        ''', (json.dumps(body), body.get('submittedAt', ''), 'submitted', existing['id']))
    else:
        conn.execute('''
            INSERT INTO reports (office_id, office_name, quarter, year, report_type, status, submitted_at, data)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            office_id,
            body.get('officeName', ''),
            quarter,
            body.get('year', datetime.now().year),
            report_type,
            'submitted',
            body.get('submittedAt', ''),
            json.dumps(body)
        ))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/login', methods=['POST'])
def login_user():
    body = request.get_json()
    office_id = body.get('office')
    role = body.get('role')
    password = body.get('password')

    conn = get_db()
    
    if role == 'manager':
        user = conn.execute('''
            SELECT * FROM users
            WHERE role = ?
        ''', (role,)).fetchone()
        valid = user and check_password_hash(user['password'], password)
    else:
        user = conn.execute('''
            SELECT * FROM users
            WHERE office_id = ? AND role = ?
        ''', (office_id, role)).fetchone()
        valid = user and check_password_hash(user['password'], password)
    
    conn.close()

    if valid:
        session.permanent = True
        session['user'] = {'office_id': user['office_id'], 'role': user['role']}
        return jsonify({'success': True})
    else:
        return jsonify({'success': False, 'error': 'invalid_credentials'})     

@app.route('/api/setup-users', methods=['POST'])
def setup_users(): 
    body = request.get_json()
    users = body.get('users', [])

    conn = get_db()
    for user in users: 
        existing = conn.execute('''
                                SELECT id FROM users 
                                WHERE office_id = ? AND role = ?
        ''', (user['office_id'], user['role'])).fetchone()

        if not existing: 
            conn.execute('''
                         INSERT INTO users (office_id, role, password)
                         VALUES(?, ?, ?)
            ''', (user['office_id'], user['role'], generate_password_hash(user['password'])))

    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/logout', methods=['POST'])
def logout_user():
    session.clear()
    return jsonify({'success': True})

@app.route('/api/me', methods=['GET'])
def get_current_user():
    user = session.get('user')
    if user:
        return jsonify({'success': True, 'user': user})
    return jsonify({'success': False, 'error': 'not_logged_in'}), 401

@app.route('/api/chart/annual-financial', methods=['GET'])
def get_annual_financial_chart():
    year = request.args.get('year', datetime.now().year)
    conn = get_db()
    rows = conn.execute('''
                        SELECT office_id, office_name, data
                        FROM reports 
                        WHERE report_type = 'annual_financial' AND year = ?
    ''', (year,)).fetchall()
    conn.close()

    chart_data = []
    for row in rows: 
        data = json.loads(row['data'])
        programs = data.get('programs') or data.get('program', [])
        total_allotment = sum(p.get('allotment', 0) for p in programs)
        total_obligations = sum(p.get('obligations',0)for p in programs)
        absorbtive = (total_obligations / total_allotment * 100) if total_allotment > 0 else 0

        chart_data.append({
            'office': row['office_id'],
            'absorptive': round(absorbtive, 2)
        })
    return jsonify(chart_data)

@app.route('/api/offices', methods=['GET'])
def get_offices():
    year = request.args.get('year', type=int)
    conn = get_db()
    rows = conn.execute('''SELECT o.id, o.name FROM offices o ORDER BY o.id''').fetchall()
    offices_data = []
    for row in rows:
        oid = row['id']
        oname = row['name']
        if year:
            progs = conn.execute('SELECT * FROM programs WHERE office_id = ? AND year = ? ORDER BY id', (oid, year)).fetchall()
        else:
            progs = conn.execute('SELECT * FROM programs WHERE office_id = ? ORDER BY id', (oid,)).fetchall()
        programs = []
        for p in progs:
            programs.append({
                'id': p['id'],
                'code': p['code'],
                'name': p['name'],
                'aipAmount': {'ps': p['aip_ps'], 'mooe': p['aip_mooe'], 'co': p['aip_co']},
                'annualBudget': {'ps': p['budget_ps'], 'mooe': p['budget_mooe'], 'co': p['budget_co'], 'total': p['budget_total']},
                'mfo': p['mfo'],
                'performanceIndicator': p['performance_indicator']
            })
        offices_data.append({'id': oid, 'name': oname, 'programs': programs})
    conn.close()
    return jsonify(offices_data)

@app.route('/api/offices/submissions', methods=['GET'])
def get_offices_submissions():
    year = request.args.get('year', datetime.now().year)
    conn = get_db()
    rows = conn.execute('''
        SELECT office_id, COUNT(*) as count, MAX(submitted_at) as last_submitted_at
        FROM reports
        WHERE year = ?
        GROUP BY office_id
    ''', (year,)).fetchall()
    conn.close()
    return jsonify({
        r['office_id']: {
            'has_submitted': True,
            'count': r['count'],
            'last_submitted_at': r['last_submitted_at']
        } for r in rows
    })

@app.route('/api/offices', methods=['POST'])
def create_office():
    body = request.get_json()
    oid = body.get('id', '').strip()
    oname = body.get('name', '').strip()
    password = body.get('password', '').strip()
    if not oid or not oname or not password:
        return jsonify({'success': False, 'error': 'id, name, and password required'}), 400
    conn = get_db()
    try:
        conn.execute('INSERT INTO offices (id, name) VALUES (?, ?)', (oid, oname))
        conn.execute("INSERT INTO users (office_id, role, password) VALUES (?, ?, ?)",
                     (oid, 'employee', generate_password_hash(password)))
        conn.commit()
    except Exception as e:
        conn.close()
        return jsonify({'success': False, 'error': str(e)}), 400
    conn.close()
    return jsonify({'success': True})

@app.route('/api/offices/<office_id>', methods=['PUT'])
def update_office(office_id):
    body = request.get_json()
    oname = body.get('name', '').strip()
    if not oname:
        return jsonify({'success': False, 'error': 'name required'}), 400
    conn = get_db()
    conn.execute('UPDATE offices SET name = ? WHERE id = ?', (oname, office_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/offices/<office_id>', methods=['DELETE'])
def delete_office(office_id):
    conn = get_db()
    conn.execute('DELETE FROM offices WHERE id = ?', (office_id,))
    conn.execute('DELETE FROM programs WHERE office_id = ?', (office_id,))
    conn.execute('DELETE FROM reports WHERE office_id = ?', (office_id,))
    conn.execute('DELETE FROM users WHERE office_id = ?', (office_id,))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/offices/<office_id>/programs', methods=['PUT'])
def update_office_programs(office_id):
    body = request.get_json()
    programs = body.get('programs', [])
    year = body.get('year', datetime.now().year)
    conn = get_db()
    conn.execute('DELETE FROM programs WHERE office_id = ? AND year = ?', (office_id, year))
    for prog in programs:
        conn.execute('''INSERT INTO programs 
            (office_id, code, name, year, aip_ps, aip_mooe, aip_co,
             budget_ps, budget_mooe, budget_co, budget_total,
             mfo, performance_indicator)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (office_id, prog.get('code',''), prog.get('name',''), year,
             prog.get('aipAmount',{}).get('ps',0),
             prog.get('aipAmount',{}).get('mooe',0),
             prog.get('aipAmount',{}).get('co',0),
             prog.get('annualBudget',{}).get('ps',0),
             prog.get('annualBudget',{}).get('mooe',0),
             prog.get('annualBudget',{}).get('co',0),
             prog.get('annualBudget',{}).get('total',0),
             prog.get('mfo',''), prog.get('performanceIndicator','')))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/aip', methods=['POST'])
def submit_aip():
    body = request.get_json()
    office_id = body['office']
    year = body.get('year', datetime.now().year)
    
    if is_past_deadline(office_id, year):
        return jsonify({'success': False, 'error': 'locked', 'message': 'Submission deadline has passed for this office.'}), 403
    
    conn = get_db()
    existing = conn.execute('''
        SELECT id FROM aip
        WHERE office_id = ? AND year = ?
    ''', (office_id, year)).fetchone()

    if existing:
        conn.execute('''
            UPDATE aip SET status = ?, submitted_at = ?, data = ?
            WHERE id = ?
        ''', ('submitted', body['submittedAt'], json.dumps(body), existing['id']))
    else:
        conn.execute('''
            INSERT INTO aip (office_id, office_name, year, status, submitted_at, data)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (
            body['office'],
            body['officeName'],
            body.get('year', datetime.now().year),
            'submitted',
            body['submittedAt'],
            json.dumps(body)
        ))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/aip/<office_id>', methods=['GET'])
def get_aip(office_id):
    year = request.args.get('year', datetime.now().year)
    conn = get_db()
    row = conn.execute('''
        SELECT * FROM aip WHERE office_id = ? AND year = ?
    ''', (office_id, year)).fetchone()
    conn.close()
    if row:
        return jsonify(json.loads(row['data']))
    return jsonify({'error': 'not found'}), 404

@app.route('/api/deadline/global', methods=['GET'])
def get_global_deadline():
    year = request.args.get('year', datetime.now().year)
    conn = get_db()
    row = conn.execute('SELECT deadline_at FROM global_deadlines WHERE year = ?', (year,)).fetchone()
    conn.close()
    if row:
        return jsonify({'deadline_at': row['deadline_at']})
    return jsonify({'deadline_at': None})

@app.route('/api/deadline/global', methods=['POST'])
def save_global_deadline():
    user = session.get('user')
    if not user or user['role'] != 'manager':
        return jsonify({'success': False, 'error': 'unauthorized'}), 403
    body = request.get_json()
    conn = get_db()
    if not body.get('deadline_at'):
        conn.execute('DELETE FROM global_deadlines WHERE year = ?', (body['year'],))
    else:
        conn.execute('''
            INSERT INTO global_deadlines (year, deadline_at)
            VALUES (?, ?)
            ON CONFLICT(year)
            DO UPDATE SET deadline_at = excluded.deadline_at
        ''', (body['year'], body['deadline_at']))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/deadlines', methods=['GET'])
def get_all_deadlines():
    year = request.args.get('year', datetime.now().year)
    conn = get_db()
    global_row = conn.execute('SELECT deadline_at FROM global_deadlines WHERE year = ?', (year,)).fetchone()
    conn.close()
    return jsonify({
        'global': global_row['deadline_at'] if global_row else None
    })

@app.route('/api/request-access', methods=['POST'])
def request_access():
    body = request.get_json()
    office_id = body['office_id']
    office_name = body['office_name']
    year = body.get('year', datetime.now().year)
    report_type = body.get('report_type', '')
    quarter = body.get('quarter', '')
    reason = body.get('reason', '')
    if not reason.strip():
        return jsonify({'success': False, 'error': 'Please provide a reason.'}), 400
    conn = get_db()
    conn.execute('''
        INSERT INTO submission_requests (office_id, office_name, year, report_type, quarter, reason, status, requested_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    ''', (office_id, office_name, year, report_type, quarter, reason.strip(), datetime.now(timezone.utc).isoformat()))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'message': 'Access request submitted. Please wait for admin approval.'})

@app.route('/api/access-requests', methods=['GET'])
def get_access_requests():
    user = session.get('user')
    if not user or user['role'] != 'manager':
        return jsonify({'success': False, 'error': 'unauthorized'}), 403
    status_filter = request.args.get('status', '')
    year = request.args.get('year', datetime.now().year)
    conn = get_db()
    if status_filter:
        rows = conn.execute('''
            SELECT * FROM submission_requests WHERE status = ? AND year = ? ORDER BY requested_at DESC
        ''', (status_filter, year)).fetchall()
    else:
        rows = conn.execute('''
            SELECT * FROM submission_requests WHERE year = ? ORDER BY requested_at DESC
        ''', (year,)).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/access-requests/<int:request_id>/approve', methods=['POST'])
def approve_access_request(request_id):
    user = session.get('user')
    if not user or user['role'] != 'manager':
        return jsonify({'success': False, 'error': 'unauthorized'}), 403
    body = request.get_json() or {}
    conn = get_db()
    conn.execute('''
        UPDATE submission_requests
        SET status = 'approved', reviewed_at = ?, reviewer_notes = ?
        WHERE id = ? AND status = 'pending'
    ''', (datetime.now(timezone.utc).isoformat(), body.get('notes', ''), request_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'message': 'Access request approved.'})

@app.route('/api/access-requests/<int:request_id>/deny', methods=['POST'])
def deny_access_request(request_id):
    user = session.get('user')
    if not user or user['role'] != 'manager':
        return jsonify({'success': False, 'error': 'unauthorized'}), 403
    body = request.get_json() or {}
    conn = get_db()
    conn.execute('''
        UPDATE submission_requests
        SET status = 'denied', reviewed_at = ?, reviewer_notes = ?
        WHERE id = ? AND status = 'pending'
    ''', (datetime.now(timezone.utc).isoformat(), body.get('notes', ''), request_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'message': 'Access request denied.'})

def is_past_deadline(office_id, year):
    conn = get_db()

    approved = conn.execute('''
        SELECT id FROM submission_requests
        WHERE office_id = ? AND year = ? AND status = 'approved'
    ''', (office_id, year)).fetchone()
    if approved:
        conn.close()
        return False

    global_row = conn.execute('SELECT deadline_at FROM global_deadlines WHERE year = ?', (year,)).fetchone()
    conn.close()
    if global_row and global_row['deadline_at']:
        deadline = datetime.fromisoformat(global_row['deadline_at'])
        if datetime.now(timezone.utc) > deadline:
            return True
    return False

if __name__ == '__main__': 
    init_db()
    seed_programs()
    # Seed default users
    conn = get_db()
    mgr = conn.execute("SELECT COUNT(*) as cnt FROM users WHERE role = 'manager'").fetchone()
    if not mgr or mgr['cnt'] == 0:
        conn.execute("INSERT INTO users (office_id, role, password) VALUES (?, ?, ?)",
                     ('manager', 'manager', generate_password_hash('manager2026')))
        conn.commit()
    
    # Seed office user accounts with default password (office id)
    offices = conn.execute("SELECT id FROM offices").fetchall()
    for office in offices:
        existing = conn.execute("SELECT id FROM users WHERE office_id = ? AND role = 'employee'",
                                (office['id'],)).fetchone()
        if not existing:
            conn.execute("INSERT INTO users (office_id, role, password) VALUES (?, ?, ?)",
                         (office['id'], 'employee', generate_password_hash(office['id'])))
    conn.commit()
    conn.close()
    app.run(debug=True)
