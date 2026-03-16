const express = require('express');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      login      TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      pass       TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // clients — пересоздаём если нет нужного PRIMARY KEY (id, owner)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_name='clients' AND tc.constraint_type='PRIMARY KEY' AND ccu.column_name='owner'
      ) THEN
        DROP TABLE IF EXISTS clients;
      END IF;
    END $$
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id         TEXT NOT NULL,
      owner      TEXT NOT NULL DEFAULT '',
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (id, owner)
    )
  `);

  // tasks — пересоздаём если нет нужного PRIMARY KEY (id, owner)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_name='tasks' AND tc.constraint_type='PRIMARY KEY' AND ccu.column_name='owner'
      ) THEN
        DROP TABLE IF EXISTS tasks;
      END IF;
    END $$
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT NOT NULL,
      owner      TEXT NOT NULL DEFAULT '',
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (id, owner)
    )
  `);

  // chat_messages
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         SERIAL PRIMARY KEY,
      type       TEXT NOT NULL DEFAULT 'all',
      msgtype    TEXT DEFAULT NULL,
      login      TEXT NOT NULL,
      "to"       TEXT,
      name       TEXT,
      text       TEXT NOT NULL,
      ts         BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS msgtype TEXT DEFAULT NULL`).catch(()=>{});
  await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS "to" TEXT`).catch(()=>{});

  // Admin по умолчанию
  const { rows } = await pool.query(`SELECT count(*) as cnt FROM accounts`);
  if (parseInt(rows[0].cnt) === 0) {
    await pool.query(
      `INSERT INTO accounts (login, name, pass, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      ['v371nt', 'Нурбек Тагаев', '1221Nt', 'admin']
    );
    console.log('✅ Admin создан');
  }
  console.log('✅ БД готова');
}

app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── ACCOUNTS ──────────────────────────────────────────────────
app.get('/api/accounts', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT login, name, pass, role FROM accounts ORDER BY created_at`);
    const result = {};
    rows.forEach(r => { result[r.login] = { name: r.name, pass: r.pass, role: r.role }; });
    res.json(result);
  } catch(e) {
    console.error('GET /api/accounts', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/register', async (req, res) => {
  const { login, name, pass } = req.body || {};
  if (!login || !name || !pass) return res.status(400).json({ error: 'Не все поля заполнены' });
  try {
    await pool.query(`INSERT INTO accounts (login, name, pass, role) VALUES ($1,$2,$3,'user')`, [login, name, pass]);
    res.json({ ok: true });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Логин уже занят' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/delete', async (req, res) => {
  const { login } = req.body || {};
  if (!login) return res.status(400).json({ error: 'login required' });
  try {
    const { rows } = await pool.query(`SELECT role FROM accounts WHERE login=$1`, [login]);
    if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    if (rows[0].role === 'admin') return res.status(403).json({ error: 'Нельзя удалить администратора' });
    await pool.query(`DELETE FROM accounts WHERE login=$1`, [login]);
    res.json({ ok: true });
  } catch(e) {
    console.error('DELETE /api/accounts/delete', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/update', async (req, res) => {
  const { login, name, pass } = req.body || {};
  if (!login || !name) return res.status(400).json({ error: 'Нет логина или имени' });
  try {
    if (pass) {
      await pool.query(`UPDATE accounts SET name=$1, pass=$2 WHERE login=$3`, [name, pass, login]);
    } else {
      await pool.query(`UPDATE accounts SET name=$1 WHERE login=$2`, [name, login]);
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENTS (по владельцу) ─────────────────────────────────────
app.get('/api/clients', async (req, res) => {
  const { owner } = req.query;
  if (!owner) return res.status(400).json({ error: 'owner required' });
  try {
    const { rows } = await pool.query(
      `SELECT data FROM clients WHERE owner=$1 ORDER BY updated_at DESC`, [owner]
    );
    res.json(rows.map(r => r.data));
  } catch(e) {
    console.error('GET /api/clients', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clients/sync', async (req, res) => {
  const { clients, owner } = req.body || {};
  if (!Array.isArray(clients)) return res.status(400).json({ error: 'clients must be array' });
  if (!owner) return res.status(400).json({ error: 'owner required' });
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(`DELETE FROM clients WHERE owner=$1`, [owner]);
    for (const c of clients) {
      if (!c || !c.id) continue;
      await conn.query(
        `INSERT INTO clients (id, owner, data, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (id, owner) DO UPDATE SET data=$3, updated_at=NOW()`,
        [c.id, owner, JSON.stringify(c)]
      );
    }
    await conn.query('COMMIT');
    res.json({ ok: true, count: clients.length });
  } catch(e) {
    await conn.query('ROLLBACK');
    console.error('POST /api/clients/sync', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

app.delete('/api/clients/:id', async (req, res) => {
  const { owner } = req.query;
  try {
    await pool.query(`DELETE FROM clients WHERE id=$1 AND owner=$2`, [req.params.id, owner||'']);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TASKS (по владельцу) ───────────────────────────────────────
app.get('/api/tasks', async (req, res) => {
  const { owner } = req.query;
  if (!owner) return res.status(400).json({ error: 'owner required' });
  try {
    const { rows } = await pool.query(
      `SELECT data FROM tasks WHERE owner=$1 ORDER BY updated_at DESC`, [owner]
    );
    res.json(rows.map(r => r.data));
  } catch(e) {
    console.error('GET /api/tasks', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tasks/sync', async (req, res) => {
  const { tasks, owner } = req.body || {};
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be array' });
  if (!owner) return res.status(400).json({ error: 'owner required' });
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(`DELETE FROM tasks WHERE owner=$1`, [owner]);
    for (const t of tasks) {
      if (!t || !t.id) continue;
      await conn.query(
        `INSERT INTO tasks (id, owner, data, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (id, owner) DO UPDATE SET data=$3, updated_at=NOW()`,
        [t.id, owner, JSON.stringify(t)]
      );
    }
    await conn.query('COMMIT');
    res.json({ ok: true });
  } catch(e) {
    await conn.query('ROLLBACK');
    console.error('POST /api/tasks/sync', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ── CHAT ───────────────────────────────────────────────────────
app.get('/api/chat/unread', async (req, res) => {
  const { login, since } = req.query;
  if (!login) return res.status(400).json({ error: 'login required' });
  try {
    const { rows } = await pool.query(
      `SELECT login, "to", name, text, ts, type, msgtype FROM chat_messages
       WHERE type='dm' AND "to"=$1 AND ts > $2 ORDER BY ts ASC`,
      [login, parseInt(since) || 0]
    );
    res.json(rows.map(r => ({ login:r.login, to:r.to, name:r.name, text:r.text, ts:Number(r.ts), type:r.type, msgtype:r.msgtype })));
  } catch(e) {
    console.error('GET /api/chat/unread', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/chat', async (req, res) => {
  try {
    const { type, user1, user2 } = req.query;
    let rows;
    if (type === 'dm' && user1 && user2) {
      ({ rows } = await pool.query(
        `SELECT login, "to", name, text, ts, type, msgtype FROM chat_messages
         WHERE type='dm' AND ((login=$1 AND "to"=$2) OR (login=$2 AND "to"=$1))
         ORDER BY ts ASC LIMIT 500`,
        [user1, user2]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT login, "to", name, text, ts, type, msgtype FROM chat_messages
         WHERE type='all' ORDER BY ts ASC LIMIT 300`
      ));
    }
    res.json(rows.map(r => ({ login:r.login, name:r.name, text:r.text, ts:Number(r.ts), type:r.type, to:r.to, msgtype:r.msgtype })));
  } catch(e) {
    console.error('GET /api/chat', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { type, login, to, name, text, ts, msgtype } = req.body || {};
  if (!login || !text) return res.status(400).json({ error: 'login и text обязательны' });
  try {
    await pool.query(
      `INSERT INTO chat_messages (type, msgtype, login, "to", name, text, ts) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [type||'all', msgtype||null, login, to||null, name||login, text, ts||Date.now()]
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('POST /api/chat', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/chat', async (req, res) => {
  try {
    await pool.query(`DELETE FROM chat_messages WHERE type='all'`);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 my.crm запущен на порту ${PORT}`)))
  .catch(err => { console.error('❌ Ошибка БД:', err.message); process.exit(1); });
