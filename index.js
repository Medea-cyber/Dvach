// Досье: Двач и Телеграм — расширение SillyTavern
// Раз в N сообщений модель читает переписку и ведёт досье на собеседников {{user}}
// в Телеграме и заметных анонов на Двача, а досье подаётся в промпт.
// Автор: Медея

const MODULE = 'board_dossier';
const INJECT_KEY = 'board_dossier_inject';
const LOG = '[Досье]';

const DEFAULT_PROMPT = `Это вспомогательная задача для совместной художественной истории (ролевой игры). Все участники — вымышленные персонажи, реальных людей здесь нет. Действие происходит в выдуманных чатах, похожих на Телеграм, и на выдуманной анонимной борде, похожей на Двач. Главный герой истории — {{user}}. {{char}} — рассказчик, который ведёт эти чаты и треды.

Твоя задача как редактора истории — вести заметки о второстепенных персонажах, чтобы автор писал их последовательно: чтобы у каждого был узнаваемый голос, своя линия и развитие, а не безликая массовка.

КАКИХ ПЕРСОНАЖЕЙ ВНОСИТЬ
• Чаты: каждого персонажа, который переписывается с {{user}} и играет хоть какую-то роль в сюжете.
• Борда: только тех анонимных персонажей, у которых уже есть своя сюжетная линия с {{user}}: отвечают больше одного раза, спорят, подшучивают, помогают, появляются снова или ярко запомнились. Эпизодическую массовку не вноси.
• Персонажу без имени дай рабочее прозвище по самой яркой черте («Анон с котом», «Зануда из /b/», «Любитель картинок»). Характерные словечки, темы и привычки, по которым автор узнаёт этого персонажа при следующем появлении, пиши в aliases.
• Если персонаж по манере, темам и привычкам — явно тот же, что уже есть в заметках, обнови его, а не заводи нового. Если два профиля оказались одним персонажем, укажи это в merge.
• Не вноси {{user}} и {{char}}.

КАК ОПИСЫВАТЬ
Коротко и конкретно, как в заметках сценариста, без пустых слов вроде «интересный» или «загадочный». Нужен живой характер, а не анкета:
• personality — 2–4 черты через поступки: что он делает, а не какой он «вообще».
• speech — его голос: регистр, пунктуация, длина реплик, мемы, эмодзи, любимые словечки, насколько груб. Описывай манеру своими словами, грубые выражения дословно не цитируй.
• attitude — как он относится к {{user}} сейчас и почему.
• current — что сейчас происходит в его сюжетной линии, настроение.
• growth — как персонаж развивается по ходу истории и куда может прийти.
• facts — только НОВЫЕ детали его предыстории и характера, которые прозвучали в истории.
• events — только НОВЫЕ важные сцены с участием {{user}}, одной строкой каждая.
• hooks — 1–3 сюжетных хода, которые он может сделать по своей инициативе.
Пиши нейтральным языком пересказа, без смакования подробностей.
{{invent}}

ЗАМЕТКИ СЕЙЧАС
{{dossier}}

ТЕКСТ ИСТОРИИ
Сообщения с пометкой [учтено] уже разобраны раньше: это контекст. Новое бери из остальных.
{{log}}

ФОРМАТ ОТВЕТА
Верни только JSON, без пояснений. В profiles — только новые и изменившиеся персонажи. Для существующих обязательно укажи id. Текстовые поля (role, personality, speech, attitude, current, growth) пиши целиком в новой редакции с учётом старой. facts и events — только добавки. hooks — актуальный список целиком. Неизменившиеся поля можно не указывать.
{
  "profiles": [
    {
      "id": "id из заметок или пусто для нового",
      "name": "имя, ник или прозвище",
      "platform": "telegram | 2ch | both",
      "aliases": ["другие имена и узнаваемые приметы"],
      "role": "кто он в истории {{user}}, одной строкой",
      "personality": "",
      "speech": "",
      "attitude": "",
      "current": "",
      "growth": "",
      "facts": [],
      "events": [],
      "hooks": [],
      "importance": 3,
      "status": "active | dormant"
    }
  ],
  "merge": [{ "from": "id дубля", "into": "id основного" }]
}
Если ничего нового нет — верни {"profiles": [], "merge": []}.`;

// начало старого стандартного промпта v1.0 — его сохранённую копию заменяем на новый
const OLD_PROMPT_START = 'Ты — архивариус ролевой игры.';

const INVENT_ON = '• Можно понемногу достраивать персонажа как автор: 1–2 правдоподобные детали за обновление (привычка, обстоятельство, мнение), если они не противоречат истории и характеру. Не превращай его в другого персонажа.';
const INVENT_OFF = '• Записывай только то, что прямо прозвучало в истории. Ничего не добавляй от себя.';

const DEFAULTS = {
    enabled: true,
    interval: 12,
    lookback: 30,
    scope: 'chat', // chat | character
    position: 1, // 0 — после системного промпта, 1 — в чате на глубине, 2 — перед промптом
    depth: 4,
    role: 0, // 0 system, 1 user, 2 assistant
    maxInjected: 8,
    allowInvent: true,
    responseLength: 4000,
    showToasts: true,
    prompt: '', // пусто = стандартный промпт
    byCharacter: {},
};

const TEXT_FIELDS = ['role', 'personality', 'speech', 'attitude', 'current', 'growth'];
const LIST_CAPS = { facts: 15, events: 12 };
const PLATFORM_LABEL = { telegram: 'Телеграм', '2ch': 'Двач', both: 'ТГ + Двач' };
const PLATFORM_LABEL_PROMPT = { telegram: 'чаты', '2ch': 'борда', both: 'чаты и борда' };

let busy = false;
let uiFilter = 'all';
const openCards = new Set();

// ---------- базовое ----------

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const es = ctx().extensionSettings;
    if (!es[MODULE] || typeof es[MODULE] !== 'object') es[MODULE] = {};
    const s = es[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    if (typeof s.prompt === 'string' && (s.prompt.trim().startsWith(OLD_PROMPT_START) || s.prompt.trim() === DEFAULT_PROMPT.trim())) {
        s.prompt = '';
    }
    return s;
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

async function saveMeta() {
    const c = ctx();
    try {
        if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else if (typeof c.saveMetadata === 'function') await c.saveMetadata();
    } catch (e) {
        console.warn(LOG, 'не удалось сохранить метаданные чата', e);
    }
}

function hasChat() {
    const c = ctx();
    return Boolean(c.chatId ?? c.getCurrentChatId?.()) && Array.isArray(c.chat);
}

function meta() {
    const c = ctx();
    if (!hasChat() || !c.chatMetadata) return null;
    const m = c.chatMetadata;
    if (!m[MODULE] || typeof m[MODULE] !== 'object') m[MODULE] = {};
    if (!Array.isArray(m[MODULE].profiles)) m[MODULE].profiles = [];
    if (typeof m[MODULE].lastIndex !== 'number') m[MODULE].lastIndex = 0;
    return m[MODULE];
}

function characterKey() {
    const c = ctx();
    if (c.groupId) return 'group:' + c.groupId;
    const ch = c.characters?.[c.characterId];
    return ch ? 'char:' + ch.avatar : null;
}

/** Массив профилей текущего хранилища (по чату или по карточке). */
function profiles() {
    const s = settings();
    if (s.scope === 'character') {
        const key = characterKey();
        if (key) {
            if (!Array.isArray(s.byCharacter[key])) s.byCharacter[key] = [];
            return s.byCharacter[key];
        }
    }
    return meta()?.profiles ?? [];
}

function setProfiles(list) {
    const s = settings();
    const key = characterKey();
    if (s.scope === 'character' && key) s.byCharacter[key] = list;
    else if (meta()) meta().profiles = list;
}

async function persist() {
    saveSettings();
    await saveMeta();
}

function toast(type, text) {
    if (!settings().showToasts && type !== 'error') return;
    try { toastr[type](text, 'Досье'); } catch { /* ignore */ }
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function norm(s) {
    return String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function uid() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function dedupe(arr) {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
        const t = String(x ?? '').trim();
        const k = norm(t);
        if (!t || !k || seen.has(k)) continue;
        seen.add(k);
        out.push(t);
    }
    return out;
}

function cleanText(t) {
    return String(t ?? '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ---------- нормализация профиля ----------

function normPlatform(p) {
    const t = norm(p);
    if (!t) return '';
    const tg = /tele|телег|\btg\b|тг/.test(t);
    const ch = /2ch|двач|dvach|борд|board|имиджборд/.test(t);
    if (/both|оба/.test(t) || (tg && ch)) return 'both';
    if (tg) return 'telegram';
    if (ch) return '2ch';
    return '';
}

function toList(v) {
    if (Array.isArray(v)) return v.map(x => String(x ?? '').trim()).filter(Boolean);
    if (typeof v === 'string' && v.trim()) return v.split(/\n|;/).map(x => x.trim()).filter(Boolean);
    return [];
}

function sanitize(raw) {
    const p = {};
    p.id = typeof raw.id === 'string' ? raw.id.trim() : '';
    p.name = String(raw.name ?? '').trim();
    p.platform = normPlatform(raw.platform);
    p.aliases = toList(raw.aliases);
    for (const f of TEXT_FIELDS) p[f] = typeof raw[f] === 'string' ? raw[f].trim() : '';
    p.facts = toList(raw.facts);
    p.events = toList(raw.events);
    p.hooks = toList(raw.hooks);
    const imp = parseInt(raw.importance, 10);
    p.importance = Number.isFinite(imp) ? Math.min(5, Math.max(1, imp)) : 0;
    const st = norm(raw.status);
    p.status = st.includes('dorm') || st.includes('спит') || st.includes('неактив') ? 'dormant' : st ? 'active' : '';
    return p;
}

function blankProfile(name, platform, at) {
    return {
        id: uid(), name, platform: platform || '2ch', aliases: [],
        role: '', personality: '', speech: '', attitude: '', current: '', growth: '',
        facts: [], events: [], hooks: [],
        importance: 2, status: 'active',
        pinned: false, locked: false, hidden: false,
        firstSeen: at, lastSeen: at, updates: 0,
    };
}

function namesOf(p) {
    return [p.name, ...(p.aliases || [])].map(norm).filter(Boolean);
}

function findExisting(list, p) {
    if (p.id) {
        const byId = list.find(x => x.id === p.id);
        if (byId) return byId;
    }
    const names = namesOf(p);
    if (!names.length) return null;
    return list.find(x => namesOf(x).some(n => names.includes(n))) ?? null;
}

function mergeInto(list, fromId, intoId) {
    const from = list.find(x => x.id === fromId);
    const into = list.find(x => x.id === intoId);
    if (!from || !into || from === into) return false;
    into.aliases = dedupe([...into.aliases, from.name, ...from.aliases]).filter(a => norm(a) !== norm(into.name)).slice(-10);
    into.facts = dedupe([...into.facts, ...from.facts]).slice(-LIST_CAPS.facts);
    into.events = dedupe([...from.events, ...into.events]).slice(-LIST_CAPS.events);
    if (into.platform !== from.platform) into.platform = 'both';
    into.importance = Math.max(into.importance || 1, from.importance || 1);
    into.firstSeen = Math.min(into.firstSeen ?? 0, from.firstSeen ?? 0);
    into.lastSeen = Math.max(into.lastSeen ?? 0, from.lastSeen ?? 0);
    list.splice(list.indexOf(from), 1);
    return true;
}

/** Вливает ответ модели в список профилей. Возвращает статистику. */
function applyResult(list, data, at) {
    const stat = { created: 0, updated: 0, merged: 0 };
    const incoming = Array.isArray(data?.profiles) ? data.profiles : [];
    for (const raw of incoming) {
        if (!raw || typeof raw !== 'object') continue;
        const p = sanitize(raw);
        let ex = findExisting(list, p);
        if (!ex) {
            if (!p.name) continue;
            ex = blankProfile(p.name, p.platform, at);
            list.push(ex);
            stat.created++;
        } else {
            stat.updated++;
        }
        ex.lastSeen = at;
        ex.updates = (ex.updates || 0) + 1;
        if (ex.locked) continue;

        if (p.name && norm(p.name) !== norm(ex.name)) {
            ex.aliases.push(ex.name);
            ex.name = p.name;
        }
        if (p.platform) {
            ex.platform = (ex.platform && ex.platform !== p.platform) ? 'both' : p.platform;
        }
        ex.aliases = dedupe([...ex.aliases, ...p.aliases]).filter(a => norm(a) !== norm(ex.name)).slice(-10);
        for (const f of TEXT_FIELDS) if (p[f]) ex[f] = p[f];
        for (const [f, cap] of Object.entries(LIST_CAPS)) ex[f] = dedupe([...ex[f], ...p[f]]).slice(-cap);
        if (p.hooks.length) ex.hooks = p.hooks.slice(0, 4);
        if (p.importance) ex.importance = p.importance;
        if (p.status) ex.status = p.status;
    }
    for (const m of Array.isArray(data?.merge) ? data.merge : []) {
        if (m && mergeInto(list, String(m.from ?? ''), String(m.into ?? ''))) stat.merged++;
    }
    return stat;
}

// ---------- запрос к модели ----------

function dossierForPrompt(list) {
    if (!list.length) return '(пусто — заметок пока нет)';
    const slim = list.map(p => {
        const o = { id: p.id, name: p.name, platform: p.platform };
        if (p.aliases.length) o.aliases = p.aliases;
        for (const f of TEXT_FIELDS) if (p[f]) o[f] = p[f];
        if (p.facts.length) o.facts = p.facts;
        if (p.events.length) o.events = p.events.slice(-6);
        if (p.hooks.length) o.hooks = p.hooks;
        o.importance = p.importance;
        o.status = p.status;
        return o;
    });
    return JSON.stringify(slim, null, 1);
}

function buildLog(chat, start, newFrom) {
    const c = ctx();
    const lines = [];
    for (let i = start; i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const who = m.is_user ? (c.name1 || 'User') : (m.name || c.name2 || 'Char');
        let text = cleanText(m.mes);
        if (!text) continue;
        if (text.length > 5000) text = text.slice(0, 5000) + ' …';
        const mark = i < newFrom ? ' [учтено]' : '';
        lines.push(`#${i}${mark} ${who}:\n${text}`);
    }
    return lines.join('\n\n');
}

function buildPrompt(list, chat, start, newFrom) {
    const s = settings();
    const c = ctx();
    let p = (s.prompt && s.prompt.trim()) ? s.prompt : DEFAULT_PROMPT;
    p = p.replace(/\{\{invent\}\}/g, s.allowInvent ? INVENT_ON : INVENT_OFF)
        .replace(/\{\{dossier\}\}/g, () => dossierForPrompt(list))
        .replace(/\{\{log\}\}/g, () => buildLog(chat, start, newFrom));
    if (typeof c.substituteParams === 'function') p = c.substituteParams(p);
    return p;
}

async function callModel(prompt) {
    const c = ctx();
    const s = settings();
    const system = 'Ты редактор художественной истории. Ведёшь заметки о вымышленных персонажах и отвечаешь строго валидным JSON.';
    const gr = c.generateRaw;
    if (typeof gr !== 'function') throw new Error('generateRaw недоступен — обнови SillyTavern');
    // Новые версии ST принимают объект, старые — позиционные аргументы
    if (gr.length === 0) {
        return await gr({ prompt, systemPrompt: system, responseLength: s.responseLength });
    }
    return await gr(prompt, null, false, false, system, s.responseLength);
}

function parseJson(text) {
    let t = String(text ?? '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/```(?:json)?/gi, '')
        .trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) {
        console.warn(LOG, 'ответ модели без JSON:', text);
        throw new Error(String(text ?? '').trim() ? 'модель ответила текстом вместо JSON (ответ — в консоли)' : 'пустой ответ — похоже, запрос заблокировал фильтр API');
    }
    t = t.slice(a, b + 1);
    try {
        return JSON.parse(t);
    } catch {
        return JSON.parse(t.replace(/,\s*([}\]])/g, '$1'));
    }
}

async function runUpdate(manual = false) {
    if (busy) {
        if (manual) toast('info', 'Обновление уже идёт');
        return;
    }
    if (!hasChat()) {
        if (manual) toast('warning', 'Сначала открой чат');
        return;
    }
    const c = ctx();
    const s = settings();
    const m = meta();
    const chatId = c.chatId ?? c.getCurrentChatId?.();
    const chat = c.chat;
    const len = chat.length;
    if (!len) return;

    const start = Math.max(0, len - Math.max(4, s.lookback));
    const newFrom = Math.min(m.lastIndex, len);
    const list = profiles();

    busy = true;
    renderStatus();
    try {
        const prompt = buildPrompt(list, chat, start, newFrom);
        const raw = await callModel(prompt);
        const data = parseJson(raw);

        const nowId = ctx().chatId ?? ctx().getCurrentChatId?.();
        if (nowId !== chatId) {
            console.warn(LOG, 'чат сменился во время обновления — результат отброшен');
            return;
        }
        const stat = applyResult(list, data, len - 1);
        meta().lastIndex = len;
        await persist();
        applyInjection();
        renderList();
        const parts = [];
        if (stat.created) parts.push(`новых: ${stat.created}`);
        if (stat.updated) parts.push(`обновлено: ${stat.updated}`);
        if (stat.merged) parts.push(`склеено: ${stat.merged}`);
        if (parts.length) toast('success', parts.join(', '));
        else if (manual) toast('info', 'Ничего нового');
    } catch (e) {
        console.error(LOG, e);
        toast('error', 'Не удалось обновить: ' + (e?.message || e));
        // сдвигаем счётчик, чтобы не долбить модель на каждом сообщении
        if (!manual && meta()) meta().lastIndex = Math.max(meta().lastIndex, len - Math.floor(s.interval / 2));
    } finally {
        busy = false;
        renderStatus();
    }
}

// ---------- подача в промпт ----------

function formatProfile(p) {
    const name1 = ctx().name1 || '{{user}}';
    const head = [`◆ ${p.name}`];
    const tag = [PLATFORM_LABEL_PROMPT[p.platform] || p.platform];
    if (p.aliases.length) tag.push('ещё: ' + p.aliases.slice(-4).join(', '));
    head.push(`[${tag.join('; ')}]`);
    if (p.role) head.push('— ' + p.role);
    if (p.status === 'dormant') head.push('(давно не появлялся в истории)');
    const out = [head.join(' ')];
    const add = (label, v) => { if (v) out.push(`  ${label}: ${v}`); };
    add('Характер', p.personality);
    add('Пишет', p.speech);
    add(`К ${name1}`, p.attitude);
    add('Сейчас', p.current);
    add('Развитие', p.growth);
    if (p.facts.length) add('Детали', p.facts.join('; '));
    if (p.events.length) add('Сцены', p.events.slice(-5).join('; '));
    if (p.hooks.length) add('Может сделать', p.hooks.join('; '));
    return out.join('\n');
}

function pickForInjection() {
    const s = settings();
    const c = ctx();
    const list = profiles().filter(p => !p.hidden);
    if (!list.length) return [];
    const chat = c.chat || [];
    const recent = ' ' + chat.slice(-3).map(m => norm(cleanText(m?.mes))).join(' ') + ' ';
    return list.map(p => {
        let score = (p.importance || 2) * 10;
        if (p.pinned) score += 1000;
        if (p.status === 'dormant') score -= 25;
        if (namesOf(p).some(n => n.length > 2 && recent.includes(' ' + n))) score += 60;
        score += Math.max(0, 20 - (chat.length - (p.lastSeen || 0)) / 3);
        return { p, score };
    }).sort((a, b) => b.score - a.score).slice(0, Math.max(1, s.maxInjected)).map(x => x.p);
}

function buildInjection() {
    const s = settings();
    if (!s.enabled || !hasChat()) return '';
    const picked = pickForInjection();
    if (!picked.length) return '';
    const name1 = ctx().name1 || '{{user}}';
    return `[Заметки о второстепенных персонажах истории — постоянных собеседниках ${name1} в чатах и на борде. У каждого свой голос, характер и память о прошлых сценах: пиши их реплики в их манере, учитывай, что было, давай им развиваться и проявлять инициативу. Задействовать всех не обязательно.]\n`
        + picked.map(formatProfile).join('\n');
}

function applyInjection() {
    const s = settings();
    const c = ctx();
    if (typeof c.setExtensionPrompt !== 'function') return;
    c.setExtensionPrompt(INJECT_KEY, buildInjection(), Number(s.position), Number(s.depth), false, Number(s.role));
}

// ---------- события ----------

function onMessageReceived() {
    setTimeout(() => {
        const s = settings();
        renderStatus();
        if (!s.enabled || busy || !hasChat()) return;
        const m = meta();
        const len = ctx().chat.length;
        if (m.lastIndex > len) m.lastIndex = len;
        if (len - m.lastIndex >= s.interval) runUpdate(false);
    }, 1200);
}

function onChatChanged() {
    openCards.clear();
    const m = meta();
    if (m && m.lastIndex > ctx().chat.length) m.lastIndex = ctx().chat.length;
    applyInjection();
    renderAll();
}

function onMessageDeleted() {
    const m = meta();
    if (m && m.lastIndex > ctx().chat.length) m.lastIndex = ctx().chat.length;
    renderStatus();
}

// ---------- интерфейс ----------

function settingsHtml() {
    return `
<div class="bd-root">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Досье: Двач и Телеграм</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="bd-row">
        <label class="checkbox_label"><input type="checkbox" id="bd-enabled"> Включено</label>
      </div>
      <div class="bd-status" id="bd-status"></div>
      <div class="bd-row">
        <div class="menu_button" id="bd-run"><i class="fa-solid fa-rotate"></i> Обновить сейчас</div>
        <div class="menu_button" id="bd-add"><i class="fa-solid fa-user-plus"></i> Добавить</div>
        <div class="menu_button" id="bd-preview-btn"><i class="fa-solid fa-eye"></i> Что уходит в промпт</div>
      </div>
      <pre class="bd-preview" id="bd-preview"></pre>

      <div class="bd-row">
        <select id="bd-filter" class="text_pole">
          <option value="all">Все</option>
          <option value="telegram">Телеграм</option>
          <option value="2ch">Двач</option>
        </select>
      </div>
      <div class="bd-list" id="bd-list"></div>

      <details>
        <summary>Настройки</summary>
        <div class="bd-row"><label>Обновлять каждые <input type="number" min="2" max="200" class="text_pole bd-num" id="bd-interval"> сообщений</label></div>
        <div class="bd-row"><label>Читать последних <input type="number" min="4" max="300" class="text_pole bd-num" id="bd-lookback"> сообщений</label></div>
        <div class="bd-hint">Окно чтения больше интервала, чтобы модель видела контекст. Уже разобранные сообщения помечаются для неё как учтённые.</div>
        <div class="bd-row"><label>Хранить досье
          <select id="bd-scope" class="text_pole">
            <option value="chat">в этом чате</option>
            <option value="character">для карточки (общее на все её чаты)</option>
          </select></label></div>
        <div class="bd-hint">При смене режима досье не переносится — используй экспорт и импорт.</div>
        <div class="bd-row"><label>Куда в промпт
          <select id="bd-position" class="text_pole">
            <option value="1">в чат на глубину</option>
            <option value="0">после системного промпта</option>
            <option value="2">перед всем промптом</option>
          </select></label>
          <label>глубина <input type="number" min="0" max="100" class="text_pole bd-num" id="bd-depth"></label>
        </div>
        <div class="bd-row"><label>Роль
          <select id="bd-role" class="text_pole">
            <option value="0">system</option>
            <option value="1">user</option>
            <option value="2">assistant</option>
          </select></label></div>
        <div class="bd-row"><label>Профилей в промпте не больше <input type="number" min="1" max="50" class="text_pole bd-num" id="bd-max"></label></div>
        <div class="bd-hint">Закреплённые идут всегда, остальные — по важности, свежести и упоминанию в последних сообщениях.</div>
        <div class="bd-row"><label>Длина ответа модели <input type="number" min="500" max="32000" step="100" class="text_pole bd-num" id="bd-resp"> токенов</label></div>
        <div class="bd-row"><label class="checkbox_label"><input type="checkbox" id="bd-invent"> Разрешить модели достраивать личность</label></div>
        <div class="bd-row"><label class="checkbox_label"><input type="checkbox" id="bd-toasts"> Уведомления об обновлениях</label></div>

        <details>
          <summary>Промпт для сбора досье</summary>
          <div class="bd-hint">Метки {{dossier}}, {{log}} и {{invent}} подставляются автоматически, их не удаляй.</div>
          <textarea id="bd-prompt" class="text_pole bd-prompt"></textarea>
          <div class="bd-row"><div class="menu_button" id="bd-prompt-reset">Вернуть стандартный</div></div>
        </details>

        <div class="bd-row">
          <div class="menu_button" id="bd-export"><i class="fa-solid fa-file-export"></i> Экспорт</div>
          <div class="menu_button" id="bd-import"><i class="fa-solid fa-file-import"></i> Импорт</div>
          <div class="menu_button" id="bd-rescan"><i class="fa-solid fa-backward"></i> Пересобрать с нуля</div>
          <div class="menu_button" id="bd-clear"><i class="fa-solid fa-trash"></i> Очистить</div>
          <input type="file" id="bd-import-file" accept=".json,application/json" hidden>
        </div>
      </details>
    </div>
  </div>
</div>`;
}

function stars(n) {
    n = Math.min(5, Math.max(1, n || 1));
    return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function cardHtml(p) {
    const open = openCards.has(p.id);
    const sub = p.role || p.personality || '';
    const ta = (field, label, rows = 2) => `
      <label class="bd-field"><span>${label}</span>
        <textarea class="text_pole" rows="${rows}" data-field="${field}">${escapeHtml(p[field])}</textarea></label>`;
    const tl = (field, label, rows = 3) => `
      <label class="bd-field"><span>${label} (по строке)</span>
        <textarea class="text_pole" rows="${rows}" data-field="${field}" data-list="1">${escapeHtml((p[field] || []).join('\n'))}</textarea></label>`;
    return `
<div class="bd-card ${open ? 'bd-open' : ''} ${p.hidden ? 'bd-hidden-card' : ''}" data-id="${escapeHtml(p.id)}">
  <div class="bd-card-head">
    <span class="bd-badge bd-${escapeHtml(p.platform)}">${escapeHtml(PLATFORM_LABEL[p.platform] || p.platform)}</span>
    <div class="bd-card-title">
      <span class="bd-card-name">${escapeHtml(p.name)}${p.status === 'dormant' ? ' 💤' : ''}</span>
      <span class="bd-card-sub">${escapeHtml(sub)}</span>
    </div>
    <span class="bd-stars">${stars(p.importance)}</span>
    <div class="bd-icons">
      <i class="bd-icon fa-solid fa-thumbtack ${p.pinned ? 'bd-on' : ''}" data-act="pinned" title="Всегда подавать в промпт"></i>
      <i class="bd-icon fa-solid fa-lock ${p.locked ? 'bd-on' : ''}" data-act="locked" title="Не давать модели менять"></i>
      <i class="bd-icon fa-solid fa-eye-slash ${p.hidden ? 'bd-on' : ''}" data-act="hidden" title="Не подавать в промпт"></i>
      <i class="bd-icon bd-danger fa-solid fa-trash" data-act="delete" title="Удалить"></i>
    </div>
  </div>
  <div class="bd-card-body">
    <div class="bd-field-row">
      <label class="bd-field"><span>Имя / кличка</span><input class="text_pole" data-field="name" value="${escapeHtml(p.name)}"></label>
      <label class="bd-field"><span>Где</span>
        <select class="text_pole" data-field="platform">
          ${Object.entries(PLATFORM_LABEL).map(([v, l]) => `<option value="${v}" ${p.platform === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
    </div>
    <div class="bd-field-row">
      <label class="bd-field"><span>Важность</span>
        <select class="text_pole" data-field="importance">
          ${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${p.importance === n ? 'selected' : ''}>${n}</option>`).join('')}
        </select></label>
      <label class="bd-field"><span>Статус</span>
        <select class="text_pole" data-field="status">
          <option value="active" ${p.status !== 'dormant' ? 'selected' : ''}>активен</option>
          <option value="dormant" ${p.status === 'dormant' ? 'selected' : ''}>пропал</option>
        </select></label>
    </div>
    <label class="bd-field"><span>Другие имена и приметы (через запятую)</span>
      <input class="text_pole" data-field="aliases" data-comma="1" value="${escapeHtml(p.aliases.join(', '))}"></label>
    ${ta('role', 'Кто он для собеседника', 1)}
    ${ta('personality', 'Характер')}
    ${ta('speech', 'Как пишет')}
    ${ta('attitude', 'Отношение')}
    ${ta('current', 'Сейчас в жизни')}
    ${ta('growth', 'Развитие')}
    ${tl('facts', 'Факты')}
    ${tl('events', 'Что было')}
    ${tl('hooks', 'Может сделать', 2)}
    <div class="bd-meta">Впервые: #${p.firstSeen ?? '?'} · последний раз: #${p.lastSeen ?? '?'} · обновлений: ${p.updates || 0}</div>
  </div>
</div>`;
}

function sortedProfiles() {
    return [...profiles()].sort((a, b) =>
        (b.pinned - a.pinned) || ((b.importance || 0) - (a.importance || 0)) || ((b.lastSeen || 0) - (a.lastSeen || 0)));
}

function renderList() {
    const $list = $('#bd-list');
    if (!$list.length) return;
    if (!hasChat()) {
        $list.html('<div class="bd-empty">Открой чат, чтобы увидеть досье.</div>');
        return;
    }
    const items = sortedProfiles().filter(p => uiFilter === 'all' || p.platform === uiFilter || p.platform === 'both');
    if (!items.length) {
        $list.html('<div class="bd-empty">Пока никого. Досье заполнится само после нескольких сообщений, или нажми «Обновить сейчас».</div>');
        return;
    }
    $list.html(items.map(cardHtml).join(''));
}

function renderStatus() {
    const $st = $('#bd-status');
    if (!$st.length) return;
    const s = settings();
    $st.toggleClass('bd-busy', busy);
    if (busy) { $st.text('⏳ Модель обновляет досье…'); return; }
    if (!hasChat()) { $st.text('Чат не открыт.'); return; }
    if (!s.enabled) { $st.text('Выключено.'); return; }
    const m = meta();
    const fresh = Math.max(0, ctx().chat.length - m.lastIndex);
    const n = profiles().length;
    $st.text(`В досье: ${n} · новых сообщений: ${Math.min(fresh, s.interval)}/${s.interval}`);
}

function renderSettings() {
    const s = settings();
    $('#bd-enabled').prop('checked', s.enabled);
    $('#bd-interval').val(s.interval);
    $('#bd-lookback').val(s.lookback);
    $('#bd-scope').val(s.scope);
    $('#bd-position').val(String(s.position));
    $('#bd-depth').val(s.depth);
    $('#bd-role').val(String(s.role));
    $('#bd-max').val(s.maxInjected);
    $('#bd-resp').val(s.responseLength);
    $('#bd-invent').prop('checked', s.allowInvent);
    $('#bd-toasts').prop('checked', s.showToasts);
    $('#bd-prompt').val(s.prompt || DEFAULT_PROMPT);
    $('#bd-filter').val(uiFilter);
}

function renderAll() {
    renderSettings();
    renderStatus();
    renderList();
    $('#bd-preview').hide();
}

function findProfile(id) {
    return profiles().find(p => p.id === id);
}

async function onProfileChanged() {
    await persist();
    applyInjection();
}

function bindUi() {
    const s = settings;
    const num = (sel, key, min, max) => $(sel).on('change', function () {
        let v = parseInt(this.value, 10);
        if (!Number.isFinite(v)) v = DEFAULTS[key];
        v = Math.min(max, Math.max(min, v));
        this.value = v;
        s()[key] = v;
        saveSettings();
        applyInjection();
        renderStatus();
    });

    $('#bd-enabled').on('change', function () { s().enabled = this.checked; saveSettings(); applyInjection(); renderStatus(); });
    num('#bd-interval', 'interval', 2, 200);
    num('#bd-lookback', 'lookback', 4, 300);
    num('#bd-depth', 'depth', 0, 100);
    num('#bd-max', 'maxInjected', 1, 50);
    num('#bd-resp', 'responseLength', 500, 32000);
    $('#bd-position').on('change', function () { s().position = Number(this.value); saveSettings(); applyInjection(); });
    $('#bd-role').on('change', function () { s().role = Number(this.value); saveSettings(); applyInjection(); });
    $('#bd-scope').on('change', function () { s().scope = this.value; saveSettings(); applyInjection(); renderStatus(); renderList(); });
    $('#bd-invent').on('change', function () { s().allowInvent = this.checked; saveSettings(); });
    $('#bd-toasts').on('change', function () { s().showToasts = this.checked; saveSettings(); });
    $('#bd-prompt').on('input', function () { s().prompt = this.value.trim() === DEFAULT_PROMPT.trim() ? '' : this.value; saveSettings(); });
    $('#bd-prompt-reset').on('click', () => { s().prompt = ''; $('#bd-prompt').val(DEFAULT_PROMPT); saveSettings(); });
    $('#bd-filter').on('change', function () { uiFilter = this.value; renderList(); });

    $('#bd-run').on('click', () => runUpdate(true));

    $('#bd-add').on('click', async () => {
        if (!hasChat()) return toast('warning', 'Сначала открой чат');
        const list = profiles();
        const p = blankProfile('Новый собеседник', uiFilter === 'telegram' ? 'telegram' : '2ch', Math.max(0, ctx().chat.length - 1));
        list.push(p);
        setProfiles(list);
        openCards.add(p.id);
        await onProfileChanged();
        renderList();
        renderStatus();
    });

    $('#bd-preview-btn').on('click', () => {
        const $pv = $('#bd-preview');
        if ($pv.is(':visible')) return $pv.hide();
        $pv.text(buildInjection() || '(пусто — в промпт ничего не уходит)').show();
    });

    $('#bd-export').on('click', () => {
        const blob = new Blob([JSON.stringify({ format: 'board_dossier', version: 1, profiles: profiles() }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `dossier-${(ctx().name2 || 'chat').replace(/[^\p{L}\p{N}_-]+/gu, '_')}.json`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    });

    $('#bd-import').on('click', () => {
        if (!hasChat()) return toast('warning', 'Сначала открой чат');
        $('#bd-import-file').val('').trigger('click');
    });
    $('#bd-import-file').on('change', async function () {
        const file = this.files?.[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            const incoming = Array.isArray(data) ? data : data.profiles;
            if (!Array.isArray(incoming)) throw new Error('в файле нет профилей');
            const list = profiles();
            let added = 0;
            for (const raw of incoming) {
                const p = sanitize(raw);
                if (!p.name || findExisting(list, { ...p, id: '' })) continue;
                const np = Object.assign(blankProfile(p.name, p.platform, 0), {
                    aliases: p.aliases, facts: p.facts, events: p.events, hooks: p.hooks,
                    importance: p.importance || 2, status: p.status || 'active',
                    pinned: Boolean(raw.pinned), locked: Boolean(raw.locked), hidden: Boolean(raw.hidden),
                });
                for (const f of TEXT_FIELDS) np[f] = p[f];
                list.push(np);
                added++;
            }
            setProfiles(list);
            await onProfileChanged();
            renderList();
            renderStatus();
            toast('success', `Импортировано: ${added}`);
        } catch (e) {
            toast('error', 'Импорт не удался: ' + (e?.message || e));
        }
    });

    $('#bd-rescan').on('click', () => {
        if (!hasChat()) return;
        if (!confirm('Модель заново прочитает последние сообщения окна как новые (досье сохранится и дополнится). Продолжить?')) return;
        meta().lastIndex = 0;
        runUpdate(true);
    });

    $('#bd-clear').on('click', async () => {
        if (!hasChat()) return;
        if (!confirm('Удалить все профили в текущем досье? Это нельзя отменить.')) return;
        setProfiles([]);
        meta().lastIndex = ctx().chat.length;
        await onProfileChanged();
        renderList();
        renderStatus();
    });

    const $list = $('#bd-list');

    $list.on('click', '.bd-card-head', function (e) {
        if ($(e.target).closest('.bd-icon').length) return;
        const $card = $(this).closest('.bd-card');
        const id = $card.data('id');
        $card.toggleClass('bd-open');
        if ($card.hasClass('bd-open')) openCards.add(id); else openCards.delete(id);
    });

    $list.on('click', '.bd-icon', async function (e) {
        e.stopPropagation();
        const id = $(this).closest('.bd-card').data('id');
        const act = $(this).data('act');
        const p = findProfile(id);
        if (!p) return;
        if (act === 'delete') {
            if (!confirm(`Удалить «${p.name}» из досье?`)) return;
            setProfiles(profiles().filter(x => x.id !== id));
        } else {
            p[act] = !p[act];
        }
        await onProfileChanged();
        renderList();
        renderStatus();
    });

    $list.on('change', '[data-field]', async function () {
        const id = $(this).closest('.bd-card').data('id');
        const p = findProfile(id);
        if (!p) return;
        const field = $(this).data('field');
        let v = $(this).val();
        if ($(this).data('list')) v = toList(v);
        else if ($(this).data('comma')) v = String(v).split(',').map(x => x.trim()).filter(Boolean);
        else if (field === 'importance') v = Number(v);
        else v = String(v).trim();
        if (field === 'name' && !v) { $(this).val(p.name); return; }
        p[field] = v;
        await onProfileChanged();
        // обновить только шапку, чтобы не сбивать фокус
        const $card = $(this).closest('.bd-card');
        $card.find('.bd-card-name').text(p.name + (p.status === 'dormant' ? ' 💤' : ''));
        $card.find('.bd-card-sub').text(p.role || p.personality || '');
        $card.find('.bd-stars').text(stars(p.importance));
        $card.find('.bd-badge').attr('class', `bd-badge bd-${p.platform}`).text(PLATFORM_LABEL[p.platform] || p.platform);
    });
}

// ---------- запуск ----------

jQuery(async () => {
    settings();
    $('#extensions_settings2').append(settingsHtml());
    bindUi();

    const c = ctx();
    const et = c.eventTypes || c.event_types;
    c.eventSource.on(et.MESSAGE_RECEIVED, onMessageReceived);
    c.eventSource.on(et.CHAT_CHANGED, onChatChanged);
    if (et.MESSAGE_DELETED) c.eventSource.on(et.MESSAGE_DELETED, onMessageDeleted);
    if (et.MESSAGE_SENT) c.eventSource.on(et.MESSAGE_SENT, () => renderStatus());
    // пересчитываем подборку перед каждой генерацией (учёт упоминаний в последних сообщениях)
    if (et.GENERATION_STARTED) c.eventSource.on(et.GENERATION_STARTED, () => applyInjection());

    onChatChanged();
    console.log(LOG, 'загружено');
});
