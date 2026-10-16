// REST API календаря событий на Express и SQLite3.
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// Путь к базе считается от файла сервера, поэтому запуск возможен из любого каталога.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'events.db');

// Открытый CORS без credentials: клиент в режиме разработки работает на другом порту.
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  optionsSuccessStatus: 204,
  maxAge: 3600,
}));

app.use(express.json());

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    // Без базы все запросы вернут 500, поэтому сервер лучше не поднимать.
    console.error('Не удалось открыть базу данных:', err.message);
    process.exit(1);
  }
  // Схема создаётся одним exec: отдельные run в этом драйвере выполняются
  // параллельно, поэтому индекс мог обогнать таблицу и падать с ошибкой.
  db.exec(
    `CREATE TABLE IF NOT EXISTS events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       title TEXT NOT NULL,
       date TEXT NOT NULL,
       time TEXT NOT NULL,
       description TEXT
     );
     CREATE INDEX IF NOT EXISTS idx_events_date_time ON events(date, time);`,
    (error) => {
      if (error) {
        console.error('Не удалось создать схему:', error.message);
        process.exit(1);
      }
    }
  );
});

// Границы допустимых дат: календарь для планирования, а не архив.
const MIN_DATE = '2000-01-01';
const MAX_DATE = '2100-12-31';

// Проверки полей события. Регулярного выражения мало: 2026-02-31 и 99:99
// проходят по форме, но такой даты и времени не существует.
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // Строки в этом формате сравниваются как даты, отдельный разбор не нужен.
  if (value < MIN_DATE || value > MAX_DATE) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function validTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hours, minutes] = value.split(':').map(Number);
  return hours <= 23 && minutes <= 59;
}

// Приводит тело запроса к виду, пригодному для записи.
function readPayload(body) {
  const { title, date, time, description } = body || {};
  const payload = {
    title: typeof title === 'string' ? title.trim() : '',
    date,
    time,
    description: description === undefined || description === null ? '' : String(description),
  };
  const valid = payload.title !== '' && validDate(date) && validTime(time);
  return { payload, valid };
}

// GET /events — все события по возрастанию даты и времени.
app.get('/events', (req, res) => {
  db.all('SELECT * FROM events ORDER BY date ASC, time ASC, id ASC', (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB_ERROR' });
    res.json(rows);
  });
});

// POST /events — создание события.
app.post('/events', (req, res) => {
  const { payload, valid } = readPayload(req.body);
  if (!valid) return res.status(400).json({ error: 'INVALID_PAYLOAD' });

  db.run(
    'INSERT INTO events (title, date, time, description) VALUES (?, ?, ?, ?)',
    [payload.title, payload.date, payload.time, payload.description],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      res.status(201).json({ id: this.lastID, ...payload });
    }
  );
});

// PUT /events/:id — полное обновление события.
app.put('/events/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'INVALID_ID' });

  const { payload, valid } = readPayload(req.body);
  if (!valid) return res.status(400).json({ error: 'INVALID_PAYLOAD' });

  db.run(
    'UPDATE events SET title=?, date=?, time=?, description=? WHERE id=?',
    [payload.title, payload.date, payload.time, payload.description, id],
    function (err) {
      if (err) return res.status(500).json({ error: 'DB_ERROR' });
      if (this.changes === 0) return res.status(404).json({ error: 'NOT_FOUND' });
      res.json({ id, ...payload });
    }
  );
});

// DELETE /events/:id — удаление события.
app.delete('/events/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'INVALID_ID' });

  db.run('DELETE FROM events WHERE id=?', [id], function (err) {
    if (err) return res.status(500).json({ error: 'DB_ERROR' });
    if (this.changes === 0) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ id, message: 'DELETED' });
  });
});

// Собранный клиент отдаётся тем же сервером, если сборка существует.
const distDir = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

app.use((req, res) => res.status(404).json({ error: 'ROUTE_NOT_FOUND' }));

// Разбор тела запроса падает раньше маршрутов: битый JSON это ошибка клиента,
// поэтому статус берётся из ошибки, а не подменяется на 500.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'INVALID_JSON' });
  }
  console.error('Ошибка запроса:', err.message);
  res.status(err.status || 500).json({ error: 'INTERNAL' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`API http://localhost:${PORT}`);
  });
}

module.exports = app;
