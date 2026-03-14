const express  = require('express');
const { Pool } = require('pg');
const path     = require('path');
const crypto   = require('crypto');
const app      = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ── DATABASE (PostgreSQL) ─────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

async function query(sql, params) {
  const client = await pool.connect();
  try   { return await client.query(sql, params); }
  finally { client.release(); }
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS accounts (
      login      TEXT PRIMARY KEY,
      pass       TEXT NOT NULL,
      name       TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'user',
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS clients (
      id         TEXT NOT NULL,
      owner      TEXT NOT NULL,
      data       TEXT NOT NULL,
      updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
      PRIMARY KEY (id, owner)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT NOT NULL,
      owner      TEXT NOT NULL,
      data       TEXT NOT NULL,
      updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
      PRIMARY KEY (id, owner)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         SERIAL PRIMARY KEY,
      login      TEXT NOT NULL,
      name       TEXT NOT NULL,
      text       TEXT NOT NULL,
      msg_type   TEXT DEFAULT 'message',
      dm_to      TEXT DEFAULT '',
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      login      TEXT NOT NULL,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS login_log (
      id         SERIAL PRIMARY KEY,
      login      TEXT NOT NULL,
      name       TEXT NOT NULL,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
    )
  `);

  // Seed default accounts if empty
  const res = await query('SELECT COUNT(*) as c FROM accounts');
  if (parseInt(res.rows[0].c) === 0) {
    await query("INSERT INTO accounts (login,pass,name,role) VALUES ('v371nt','1221Nt','Нурбек Тагаев','admin')");
    await query("INSERT INTO accounts (login,pass,name,role) VALUES ('v371aa','Pass1a','Менеджер 1','user')");
    await query("INSERT INTO accounts (login,pass,name,role) VALUES ('v371bb','Pass1b','Менеджер 2','user')");
    console.log('Default accounts created');
  }

  console.log('Database ready');
}

// Chat: delete messages older than 24h
// Chat cleanup — every day at 18:00 Bishkek (12:00 UTC)
async function cleanChat() {
  const r = await query('DELETE FROM chat_messages');
  console.log('Chat cleared at 18:00 Bishkek (' + (r.rowCount||0) + ' messages)');
}

function scheduleCleanChat() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(12, 0, 0, 0); // 12:00 UTC = 18:00 Bishkek
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const msUntil = next - now;
  console.log('Chat will clear in ' + Math.round(msUntil/3600000*10)/10 + ' hours (18:00 Bishkek)');
  setTimeout(function() {
    cleanChat();
    setInterval(cleanChat, 24 * 60 * 60 * 1000);
  }, msUntil);
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
async function auth(req, res, next) {
  const token = req.headers['x-session'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sess = await query('SELECT login FROM sessions WHERE token=$1', [token]);
    if (!sess.rows.length) return res.status(401).json({ error: 'Session expired' });
    const acc = await query('SELECT * FROM accounts WHERE login=$1', [sess.rows[0].login]);
    if (!acc.rows.length) return res.status(401).json({ error: 'Account not found' });
    req.user = acc.rows[0];
    next();
  } catch(e) { res.status(500).json({ error: e.message }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { login, pass } = req.body;
    const r = await query('SELECT * FROM accounts WHERE login=$1', [login]);
    if (!r.rows.length || r.rows[0].pass !== pass)
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    const acc = r.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    await query('INSERT INTO sessions (token,login) VALUES ($1,$2)', [token, login]);
    await query('DELETE FROM sessions WHERE login=$1 AND token!=$2', [login, token]);
    await query('INSERT INTO login_log (login,name) VALUES ($1,$2)', [login, acc.name]);
    res.json({ token, login: acc.login, name: acc.name, role: acc.role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', auth, (req, res) => {
  res.json({ login: req.user.login, name: req.user.name, role: req.user.role });
});

app.post('/api/logout', auth, async (req, res) => {
  await query('DELETE FROM sessions WHERE token=$1', [req.headers['x-session']]);
  res.json({ ok: true });
});

app.post('/api/register', async (req, res) => {
  try {
    const { login, pass, name } = req.body;
    if (!/^v371[a-z]{2}$/.test(login)) return res.status(400).json({ error: 'Логин: v371 + 2 строчные латинские буквы' });
    if (!pass || pass.length < 4 || pass.length > 6) return res.status(400).json({ error: 'Пароль: 4-6 символов' });
    if (!/[A-Z]/.test(pass)) return res.status(400).json({ error: 'Нужна заглавная буква' });
    if (!/[a-z]/.test(pass)) return res.status(400).json({ error: 'Нужна строчная буква' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'Введите имя' });
    const exists = await query('SELECT login FROM accounts WHERE login=$1', [login]);
    if (exists.rows.length) return res.status(400).json({ error: 'Логин уже занят' });
    await query('INSERT INTO accounts (login,pass,name,role) VALUES ($1,$2,$3,$4)', [login, pass, name.trim(), 'user']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/profile', auth, async (req, res) => {
  try {
    const { name, pass } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Введите имя' });
    if (pass) {
      if (pass.length < 4 || pass.length > 6) return res.status(400).json({ error: 'Пароль: 4-6 символов' });
      if (!/[A-Z]/.test(pass)) return res.status(400).json({ error: 'Нужна заглавная буква' });
      if (!/[a-z]/.test(pass)) return res.status(400).json({ error: 'Нужна строчная буква' });
      await query('UPDATE accounts SET name=$1, pass=$2 WHERE login=$3', [name.trim(), pass, req.user.login]);
    } else {
      await query('UPDATE accounts SET name=$1 WHERE login=$2', [name.trim(), req.user.login]);
    }
    res.json({ ok: true, name: name.trim() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTS (per user) ────────────────────────────────────────────────────────
app.get('/api/clients', auth, async (req, res) => {
  try {
    const r = await query('SELECT data FROM clients WHERE owner=$1 ORDER BY updated_at DESC', [req.user.login]);
    res.json(r.rows.map(row => JSON.parse(row.data)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/sync', auth, async (req, res) => {
  try {
    const { clients } = req.body;
    if (!Array.isArray(clients)) return res.status(400).json({ error: 'Expected array' });
    const owner = req.user.login;
    const now = Date.now();

    // Get existing IDs for this owner
    const existing = await query('SELECT id FROM clients WHERE owner=$1', [owner]);
    const existingIds = new Set(existing.rows.map(r => r.id));
    const incomingIds = new Set(clients.map(c => c.id));

    // Delete removed
    for (const id of existingIds) {
      if (!incomingIds.has(id)) {
        await query('DELETE FROM clients WHERE id=$1 AND owner=$2', [id, owner]);
      }
    }
    // Upsert all
    for (const c of clients) {
      await query(
        'INSERT INTO clients (id,owner,data,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id,owner) DO UPDATE SET data=$3, updated_at=$4',
        [c.id, owner, JSON.stringify(c), now]
      );
    }
    res.json({ ok: true, count: clients.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TASKS (per user) ──────────────────────────────────────────────────────────
app.get('/api/tasks', auth, async (req, res) => {
  try {
    const r = await query('SELECT data FROM tasks WHERE owner=$1 ORDER BY updated_at DESC', [req.user.login]);
    res.json(r.rows.map(row => JSON.parse(row.data)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tasks/sync', auth, async (req, res) => {
  try {
    const { tasks } = req.body;
    if (!Array.isArray(tasks)) return res.status(400).json({ error: 'Expected array' });
    const owner = req.user.login;
    const now = Date.now();

    const existing = await query('SELECT id FROM tasks WHERE owner=$1', [owner]);
    const existingIds = new Set(existing.rows.map(r => r.id));
    const incomingIds = new Set(tasks.map(t => t.id));

    for (const id of existingIds) {
      if (!incomingIds.has(id)) {
        await query('DELETE FROM tasks WHERE id=$1 AND owner=$2', [id, owner]);
      }
    }
    for (const t of tasks) {
      await query(
        'INSERT INTO tasks (id,owner,data,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id,owner) DO UPDATE SET data=$3, updated_at=$4',
        [t.id, owner, JSON.stringify(t), now]
      );
    }
    res.json({ ok: true, count: tasks.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CHAT (shared) ─────────────────────────────────────────────────────────────
app.get('/api/chat', auth, async (req, res) => {
  try {
    const since = parseInt(req.query.since || '0');
    const r = await query('SELECT * FROM chat_messages WHERE created_at > $1 ORDER BY created_at ASC LIMIT 200', [since]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat', auth, async (req, res) => {
  try {
    const { text, msg_type, dm_to } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Empty' });
    const r = await query(
      'INSERT INTO chat_messages (login,name,text,msg_type,dm_to) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.user.login, req.user.name, text.trim(), msg_type || 'message', dm_to || '']
    );
    res.json({ id: r.rows[0].id, ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  try {
    const [users, clients, tasks, msgs] = await Promise.all([
      query('SELECT COUNT(*) as c FROM accounts'),
      query('SELECT COUNT(*) as c FROM clients'),
      query('SELECT COUNT(*) as c FROM tasks'),
      query('SELECT COUNT(*) as c FROM chat_messages')
    ]);
    res.json({
      users:   parseInt(users.rows[0].c),
      clients: parseInt(clients.rows[0].c),
      tasks:   parseInt(tasks.rows[0].c),
      msgs:    parseInt(msgs.rows[0].c)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users/full', auth, adminOnly, async (req, res) => {
  try {
    const users = await query('SELECT login,name,pass,role,created_at FROM accounts ORDER BY created_at ASC');
    const result = await Promise.all(users.rows.map(async u => {
      const cc = await query('SELECT COUNT(*) as c FROM clients WHERE owner=$1', [u.login]);
      const tc = await query('SELECT COUNT(*) as c FROM tasks WHERE owner=$1', [u.login]);
      return { ...u, client_count: parseInt(cc.rows[0].c), task_count: parseInt(tc.rows[0].c) };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:login', auth, adminOnly, async (req, res) => {
  try {
    const { login } = req.params;
    if (login === 'v371nt') return res.status(403).json({ error: 'Нельзя удалить главного администратора' });
    await query('DELETE FROM clients WHERE owner=$1', [login]);
    await query('DELETE FROM tasks WHERE owner=$1', [login]);
    await query('DELETE FROM sessions WHERE login=$1', [login]);
    await query('DELETE FROM accounts WHERE login=$1', [login]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/chat', auth, adminOnly, async (req, res) => {
  try {
    await query('DELETE FROM chat_messages');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/announce', auth, adminOnly, async (req, res) => {
  try {
    if (!req.body.text) return res.status(400).json({ error: 'Empty' });
    await query(
      'INSERT INTO chat_messages (login,name,text,msg_type) VALUES ($1,$2,$3,$4)',
      ['admin', 'Администратор', '📢 ' + req.body.text, 'system']
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/login-log', auth, adminOnly, async (req, res) => {
  try {
    const r = await query('SELECT * FROM login_log ORDER BY created_at DESC LIMIT 50');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STATIC ────────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    scheduleCleanChat();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`TAGAEV CRM → http://0.0.0.0:${PORT}`);
    });
  })
  .catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
