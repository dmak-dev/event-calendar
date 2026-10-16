<template>
  <div class="container">
    <h1>Календарь событий</h1>

    <!-- Сообщение о неудачном запросе: без него ошибка видна только в консоли -->
    <div v-if="error" class="error">{{ error }}</div>

    <!-- Форма добавления: минимальный набор полей с 24ч time и кнопкой "Сейчас" -->
    <form class="event-form" @submit.prevent="addEvent">
      <input v-model.trim="newEvent.title" type="text" placeholder="Название" required />
      <input v-model="newEvent.date" type="date" required />

      <div class="time-row">
        <input v-model="newEvent.time" type="time" required />
        <button type="button" class="tiny" @click="setNowForCreate">Сейчас</button>
      </div>

      <input v-model.trim="newEvent.description" type="text" placeholder="Описание (необязательно)" />
      <button type="submit">Добавить</button>
    </form>

    <!-- Переключение режимов: список по дням или сетка месяца -->
    <div class="views">
      <div class="view-switch">
        <button :class="{ active: view === 'list' }" @click="view = 'list'">Список</button>
        <button :class="{ active: view === 'grid' }" @click="view = 'grid'">Месяц</button>
      </div>
      <div class="cal-nav" v-if="view === 'grid'">
        <button class="tiny" @click="shiftMonth(-1)" aria-label="Предыдущий месяц">&#8592;</button>
        <span class="cal-month">{{ monthLabel }}</span>
        <button class="tiny" @click="shiftMonth(1)" aria-label="Следующий месяц">&#8594;</button>
        <button class="tiny" @click="goToday">Сегодня</button>
      </div>
    </div>

    <!-- Режим сетки: месяц целиком, событие открывается на редактирование -->
    <div v-if="view === 'grid'" class="cal-grid">
      <div v-for="w in weekdays" :key="w" class="cal-weekday">{{ w }}</div>
      <div v-for="day in gridDays" :key="day.iso"
           class="cal-cell"
           :class="{ out: !day.inMonth, today: day.isToday }"
           :title="day.iso"
           @click="pickDate(day.iso)">
        <div class="cal-day-num">{{ day.day }}</div>
        <button v-for="ev in day.events" :key="ev.id"
                class="cal-event"
                :title="`${ev.time} ${ev.title}`"
                @click.stop="openEdit(ev)">
          <span class="cal-event-time">{{ ev.time }}</span> {{ ev.title }}
        </button>
      </div>
    </div>

    <!-- Режим списка: события, сгруппированные по дате -->
    <template v-else>
      <div v-if="datesSorted.length === 0" class="empty">События отсутствуют</div>
      <div v-else class="events">
        <div v-for="d in datesSorted" :key="d" class="day-block">
          <h3 class="day-title">{{ d }}</h3>
          <ul class="day-list">
            <li v-for="ev in grouped[d]" :key="ev.id" class="event-item">
              <div class="event-line">
                <span class="event-time">{{ ev.time }}</span>
                <span class="event-title">{{ ev.title }}</span>
              </div>
              <div class="event-desc" v-if="ev.description">{{ ev.description }}</div>
              <div class="event-actions">
                <button @click="openEdit(ev)">Редактировать</button>
                <button class="danger" @click="openDelete(ev)">Удалить</button>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </template>


    <!-- Модал удаления: простое подтверждение -->
    <div class="modal-backdrop" v-if="deleteModal.open" @click="closeDelete">
      <div class="modal" @click.stop>
        <h3>Удалить событие?</h3>
        <p>{{ deleteModal.event?.date }} {{ deleteModal.event?.time }} — {{ deleteModal.event?.title }}</p>
        <div class="modal-actions">
          <button class="danger" @click="confirmDelete">Удалить</button>
          <button @click="closeDelete">Отмена</button>
        </div>
      </div>
    </div>

    <!-- Модал редактирования: поля как при добавлении + "Сейчас" для времени -->
    <div class="modal-backdrop" v-if="editModal.open" @click="closeEdit">
      <div class="modal" @click.stop>
        <h3>Редактирование события</h3>
        <form @submit.prevent="confirmEdit">
          <input v-model.trim="editModal.model.title" type="text" required />
          <input v-model="editModal.model.date" type="date" required />

          <div class="time-row">
            <input v-model="editModal.model.time" type="time" required />
            <button type="button" class="tiny" @click="setNowForEdit">Сейчас</button>
          </div>

          <input v-model.trim="editModal.model.description" type="text" placeholder="Описание" />
          <div class="modal-actions">
            <button type="submit">Сохранить</button>
            <button type="button" @click="closeEdit">Отмена</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
// Этот компонент реализует форму/список/модали и CRUD через Axios.
import { reactive, ref, computed, onMounted } from 'vue';
import axios from 'axios';

// Адрес API. По умолчанию запросы идут на тот же адрес, с которого открыта страница:
// в собранном виде клиент раздаёт сам сервер. Для отдельного клиента в разработке
// запросы уходят через прокси Vite, а переменная VITE_API_URL задаёт адрес вручную.
const API = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

// Состояние приложения хранит массив событий, модели форм/модалей и текст ошибки.
const events = ref([]);
const error = ref('');
const newEvent = reactive({ title: '', date: todayISO(), time: '09:00', description: '' });

// Режим отображения и месяц, показанный в сетке.
const view = ref('list');
const cursor = ref(new Date());

const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const deleteModal = reactive({ open: false, event: null });
const editModal = reactive({ open: false, model: { id: null, title: '', date: '', time: '', description: '' } });

// Дата в формате ГГГГ-ММ-ДД по локальному времени. Через toISOString() дата
// уезжает на соседний день при смещении часового пояса.
function isoOf(d) {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}
function todayISO() {
  return isoOf(new Date());
}

// Текст ошибки для пользователя: сообщение сервера, если оно есть.
function readError(err, fallback) {
  return err?.response?.data?.error === 'INVALID_PAYLOAD'
    ? 'Проверьте название, дату и время события'
    : fallback;
}

// Группировка событий по дате и сортировка по времени.
const grouped = computed(() => {
  const map = {};
  for (const e of [...events.value].sort((a,b)=> (a.date + 'T' + a.time).localeCompare(b.date + 'T' + b.time))) {
    (map[e.date] ||= []).push(e);
  }
  return map;
});
const datesSorted = computed(() => Object.keys(grouped.value).sort());

// Сетка месяца: 42 ячейки, неделя начинается с понедельника.
const gridDays = computed(() => {
  const year = cursor.value.getFullYear();
  const month = cursor.value.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
  const today = todayISO();

  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const iso = isoOf(d);
    return {
      iso,
      day: d.getDate(),
      inMonth: d.getMonth() === month,
      isToday: iso === today,
      events: grouped.value[iso] || [],
    };
  });
});

const monthLabel = computed(() => cursor.value.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }));

function shiftMonth(delta) {
  cursor.value = new Date(cursor.value.getFullYear(), cursor.value.getMonth() + delta, 1);
}
function goToday() {
  cursor.value = new Date();
}
// Клик по дню в сетке подставляет дату в форму добавления.
function pickDate(iso) {
  newEvent.date = iso;
}

// Утилита для формирования текущего времени HH:MM (24 часа).
function nowHHMM() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Кнопки "Сейчас" подставляют текущее время в соответствующие модели.
function setNowForCreate() {
  newEvent.time = nowHHMM();
}
function setNowForEdit() {
  editModal.model.time = nowHHMM();
}

// CRUD операции с синхронизацией списка.
async function fetchEvents() {
  try {
    const r = await axios.get(`${API}/events`);
    events.value = Array.isArray(r.data) ? r.data : [];
    error.value = '';
  } catch (err) {
    error.value = readError(err, 'Не удалось загрузить события. Сервер доступен?');
  }
}

async function addEvent() {
  const p = { title: newEvent.title.trim(), date: newEvent.date, time: newEvent.time, description: (newEvent.description || '').trim() };
  if (!p.title || !p.date || !p.time) return;
  try {
    const r = await axios.post(`${API}/events`, p);
    events.value.push(r.data);
    error.value = '';
    newEvent.title = ''; newEvent.description = '';
    newEvent.date = todayISO();
    newEvent.time = '09:00';
  } catch (err) {
    error.value = readError(err, 'Не удалось добавить событие');
  }
}

function openDelete(ev) { deleteModal.open = true; deleteModal.event = ev; }
function closeDelete() { deleteModal.open = false; deleteModal.event = null; }

async function confirmDelete() {
  if (!deleteModal.event) return;
  try {
    await axios.delete(`${API}/events/${deleteModal.event.id}`);
    events.value = events.value.filter(e => e.id !== deleteModal.event.id);
    error.value = '';
  } catch (err) {
    error.value = readError(err, 'Не удалось удалить событие');
  }
  closeDelete();
}

// Описание из старой записи может оказаться не строкой, поэтому приводим его к тексту.
function openEdit(ev) {
  editModal.open = true;
  editModal.model = { ...ev, description: String(ev.description ?? '') };
}

function closeEdit() { editModal.open = false; editModal.model = { id:null, title:'', date:'', time:'', description:'' }; }

async function confirmEdit() {
  const m = editModal.model;
  if (!m.title.trim() || !m.date || !m.time) return;
  try {
    const r = await axios.put(`${API}/events/${m.id}`, {
      title: m.title.trim(), date: m.date, time: m.time, description: (m.description || '').trim()
    });
    const i = events.value.findIndex(e => e.id === m.id);
    if (i !== -1) events.value.splice(i, 1, r.data);
    error.value = '';
    closeEdit();
  } catch (err) {
    error.value = readError(err, 'Не удалось сохранить изменения');
  }
}

// При монтировании загружается список; дата формы задана при создании состояния.
onMounted(fetchEvents);
</script>
