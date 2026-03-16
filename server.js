const express = require('express');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── PostgreSQL ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ─── Создаём таблицы при старте ──────────────────────────────
async function initDB() {
  // Каждый CREATE отдельно — если одна упадёт, видно какая именно
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      login      TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      pass       TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id         TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         SERIAL PRIMARY KEY,
      type       TEXT NOT NULL DEFAULT 'all',
      login      TEXT NOT NULL,
      "to"       TEXT,
      name       TEXT,
      text       TEXT NOT NULL,
      ts         BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Добавляем колонки если их нет (для уже существующих БД)
  await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS msgtype TEXT DEFAULT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS "to" TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS ts BIGINT`).catch(() => {});

  // Admin по умолчанию
  const { rows } = await pool.query(`SELECT count(*) as cnt FROM accounts`);
  if (parseInt(rows[0].cnt) === 0) {
    await pool.query(
      `INSERT INTO accounts (login, name, pass, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      ['v371nt', 'Нурбек Тагаев', '1221Nt', 'admin']
    );
    console.log('✅ Admin-аккаунт создан');
  }
  console.log('✅ БД готова');
}

// ─── Middleware ───────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// API-роуты РАНЬШЕ статики — иначе express.static перехватит /api/*
// ═════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ═════════════════════════════════════════════════════════════
//  ACCOUNTS
// ═════════════════════════════════════════════════════════════
app.get('/api/accounts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT login, name, pass, role FROM accounts ORDER BY created_at`
    );
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
  if (!login || !name || !pass)
    return res.status(400).json({ error: 'Не все поля заполнены' });
  try {
    await pool.query(
      `INSERT INTO accounts (login, name, pass, role) VALUES ($1,$2,$3,'user')`,
      [login, name, pass]
    );
    res.json({ ok: true });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Логин уже занят' });
    console.error('POST /api/accounts/register', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/update', async (req, res) => {
  const { login, name, pass } = req.body || {};
  if (!login || !name)
    return res.status(400).json({ error: 'Нет логина или имени' });
  try {
    if (pass) {
      await pool.query(
        `UPDATE accounts SET name=$1, pass=$2 WHERE login=$3`, [name, pass, login]
      );
    } else {
      await pool.query(`UPDATE accounts SET name=$1 WHERE login=$2`, [name, login]);
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('POST /api/accounts/update', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════
//  CLIENTS
// ═════════════════════════════════════════════════════════════
app.get('/api/clients', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT data FROM clients ORDER BY updated_at DESC`
    );
    res.json(rows.map(r => r.data));
  } catch(e) {
    console.error('GET /api/clients', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clients/sync', async (req, res) => {
  const { clients } = req.body || {};
  if (!Array.isArray(clients))
    return res.status(400).json({ error: 'clients must be array' });
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(`DELETE FROM clients`);
    for (const c of clients) {
      if (!c || !c.id) continue;
      await conn.query(
        `INSERT INTO clients (id, data) VALUES ($1,$2)
         ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW()`,
        [c.id, JSON.stringify(c)]
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
  try {
    await pool.query(`DELETE FROM clients WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════
//  TASKS
// ═════════════════════════════════════════════════════════════
app.get('/api/tasks', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT data FROM tasks ORDER BY updated_at DESC`
    );
    res.json(rows.map(r => r.data));
  } catch(e) {
    console.error('GET /api/tasks', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tasks/sync', async (req, res) => {
  const { tasks } = req.body || {};
  if (!Array.isArray(tasks))
    return res.status(400).json({ error: 'tasks must be array' });
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(`DELETE FROM tasks`);
    for (const t of tasks) {
      if (!t || !t.id) continue;
      await conn.query(
        `INSERT INTO tasks (id, data) VALUES ($1,$2)
         ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW()`,
        [t.id, JSON.stringify(t)]
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

// ═════════════════════════════════════════════════════════════
//  CHAT
// ═════════════════════════════════════════════════════════════
app.get('/api/chat/unread', async (req, res) => {
  const { login, since } = req.query;
  if (!login) return res.status(400).json({ error: 'login required' });
  const sinceTs = parseInt(since) || 0;
  try {
    const { rows } = await pool.query(
      `SELECT login, "to", name, text, ts, type, msgtype
       FROM chat_messages
       WHERE type='dm' AND "to"=$1 AND ts > $2
       ORDER BY ts ASC`,
      [login, sinceTs]
    );
    res.json(rows.map(r => ({
      login: r.login, to: r.to, name: r.name,
      text: r.text, ts: Number(r.ts), type: r.type, msgtype: r.msgtype
    })));
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
         WHERE type='dm' AND (
           (login=$1 AND "to"=$2) OR (login=$2 AND "to"=$1)
         ) ORDER BY ts ASC LIMIT 500`,
        [user1, user2]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT login, "to", name, text, ts, type, msgtype
         FROM chat_messages WHERE type='all'
         ORDER BY ts ASC LIMIT 300`
      ));
    }
    res.json(rows.map(r => ({
      login: r.login, name: r.name, text: r.text,
      ts: Number(r.ts), type: r.type, to: r.to, msgtype: r.msgtype
    })));
  } catch(e) {
    console.error('GET /api/chat', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { type, login, to, name, text, ts, msgtype } = req.body || {};
  if (!login || !text)
    return res.status(400).json({ error: 'login и text обязательны' });
  try {
    await pool.query(
      `INSERT INTO chat_messages (type, msgtype, login, "to", name, text, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [type || 'all', msgtype || null, login, to || null,
       name || login, text, ts || Date.now()]
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

// ─── Статика и SPA-fallback (ПОСЛЕ всех API) ──────────────────
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Старт ────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 my.crm запущен на порту ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Ошибка БД при старте:', err.message);
    process.exit(1);
  });
