// Проверки REST API календаря. Работают на отдельной базе во временном каталоге,
// поэтому events.db в репозитории не изменяется.
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Путь к базе читается при подключении модуля, поэтому задаётся до require.
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-test-'));
process.env.DB_PATH = path.join(testDir, 'events.db');

const app = require('../server');

let server;
let baseUrl;

const post = (body) => fetch(`${baseUrl}/events`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const sample = { title: 'Собеседование', date: '2026-11-03', time: '14:30', description: 'Онлайн' };

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  // Каталог не удаляем: соединение sqlite3 остаётся открытым до конца процесса,
  // и запрос, попавший после удаления файла, падает с «no such table».
  server.close();
});

test('пустой календарь отдаёт пустой массив', async () => {
  const res = await fetch(`${baseUrl}/events`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test('событие создаётся и возвращается с идентификатором', async () => {
  const res = await post(sample);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(Number.isInteger(body.id));
  assert.equal(body.title, sample.title);
  assert.equal(body.date, sample.date);
  assert.equal(body.time, sample.time);
  assert.equal(body.description, sample.description);
});

test('список отдаётся по возрастанию даты и времени', async () => {
  await post({ title: 'Позже', date: '2026-12-01', time: '09:00' });
  await post({ title: 'Раньше', date: '2026-11-03', time: '08:00' });

  const rows = await (await fetch(`${baseUrl}/events`)).json();
  const keys = rows.map((r) => `${r.date}T${r.time}`);
  assert.deepEqual(keys, [...keys].sort());
});

test('название из пробелов отклоняется', async () => {
  const res = await post({ ...sample, title: '   ' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'INVALID_PAYLOAD');
});

test('несуществующая дата отклоняется', async () => {
  for (const date of ['2026-02-31', '2025-99-99', '2026-13-01', '03-11-2026']) {
    const res = await post({ ...sample, date });
    assert.equal(res.status, 400, `дата ${date} должна отклоняться`);
  }
});

test('несуществующее время отклоняется', async () => {
  for (const time of ['99:99', '24:00', '12:60', '12-30']) {
    const res = await post({ ...sample, time });
    assert.equal(res.status, 400, `время ${time} должно отклоняться`);
  }
});

test('дата вне допустимого диапазона отклоняется', async () => {
  for (const date of ['1999-12-31', '2101-01-01', '1900-05-05']) {
    const res = await post({ ...sample, date });
    assert.equal(res.status, 400, `дата ${date} должна отклоняться`);
  }
  for (const date of ['2000-01-01', '2100-12-31']) {
    const res = await post({ ...sample, title: `Граница ${date}`, date });
    assert.equal(res.status, 201, `дата ${date} должна приниматься`);
  }
});

test('CORS разрешает только клиент разработки', async () => {
  const allowed = await fetch(`${baseUrl}/events`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');

  const other = await fetch(`${baseUrl}/events`, { headers: { Origin: 'http://other.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('числовое описание сохраняется строкой', async () => {
  const res = await post({ ...sample, title: 'Число', description: 123 });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).description, '123');
});

test('описание можно не передавать', async () => {
  const res = await post({ title: 'Без описания', date: '2026-11-04', time: '10:00' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).description, '');
});

test('битый JSON это ошибка клиента, а не сервера', async () => {
  const res = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{битый',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'INVALID_JSON');
});

test('событие обновляется целиком', async () => {
  const created = await (await post({ title: 'Черновик', date: '2026-11-05', time: '11:00' })).json();
  const res = await fetch(`${baseUrl}/events/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Итог', date: '2026-11-06', time: '12:15', description: 'готово' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, 'Итог');
  assert.equal(body.date, '2026-11-06');

  const rows = await (await fetch(`${baseUrl}/events`)).json();
  const stored = rows.find((r) => r.id === created.id);
  assert.equal(stored.time, '12:15');
});

test('обновление отсутствующего события отдаёт 404', async () => {
  const res = await fetch(`${baseUrl}/events/9999`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sample),
  });
  assert.equal(res.status, 404);
});

test('некорректный идентификатор отклоняется', async () => {
  assert.equal((await fetch(`${baseUrl}/events/abc`, { method: 'DELETE' })).status, 400);
  assert.equal((await fetch(`${baseUrl}/events/0`, { method: 'DELETE' })).status, 400);
  assert.equal((await fetch(`${baseUrl}/events/-3`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sample) })).status, 400);
});

test('событие удаляется один раз', async () => {
  const created = await (await post({ title: 'Временное', date: '2026-11-07', time: '13:00' })).json();

  const first = await fetch(`${baseUrl}/events/${created.id}`, { method: 'DELETE' });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).message, 'DELETED');

  const second = await fetch(`${baseUrl}/events/${created.id}`, { method: 'DELETE' });
  assert.equal(second.status, 404);
});

test('неизвестный маршрут отдаёт 404', async () => {
  const res = await fetch(`${baseUrl}/unknown`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'ROUTE_NOT_FOUND');
});
