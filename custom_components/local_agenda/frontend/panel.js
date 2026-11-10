// Local Agenda — panel
// Vanilla JS custom element, no build step required.
// Registered automatically by the integration via async_register_built_in_panel.
//
// Views: week (day on a phone), month, house, list and executions; an event
// editor with its start and end rules.  Every date and time exchanged with
// the backend is wall-clock time in Home Assistant's time zone
// ("2026-11-10T06:30", or "2026-11-10" for an all-day event), so the panel
// never converts between time zones itself.

const VERSION = "2.0.0";
console.info(`%c[local_agenda] panel.js v${VERSION} loaded`, "color:#03a9f4;font-weight:bold;");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasOnlyKeys(obj, allowed) {
  return Object.keys(obj).every(k => allowed.includes(k));
}

function deepCopy(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function icon(name, extra = "") {
  return el("ha-icon", { icon: name.startsWith("mdi:") ? name : `mdi:${name}`, class: `ic ${extra}`.trim() });
}

// Minimal YAML serialiser: enough for action and condition blocks.
function toYaml(obj, indent = 0) {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean") return obj ? "true" : "false";
  if (typeof obj === "number") return String(obj);
  if (typeof obj === "string") {
    if (obj === "") return '""';
    if (obj.includes("\n")) return JSON.stringify(obj);
    if (/[:#\[\]{},&*?|<>=!%@`'"]/.test(obj) || /^\s|\s$/.test(obj) || /^-/.test(obj) ||
        /^(true|false|null|yes|no|on|off|~)$/i.test(obj) || /^[\d.+-]/.test(obj)) {
      return JSON.stringify(obj);
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return obj.map(item => {
      if (isPlainObject(item) && Object.keys(item).length) {
        const lines = toYaml(item, indent + 1).split("\n");
        return `${pad}- ${lines[0].trimStart()}${lines.length > 1 ? "\n" + lines.slice(1).join("\n") : ""}`;
      }
      if (Array.isArray(item) && item.length) return `${pad}-\n${toYaml(item, indent + 1)}`;
      return `${pad}- ${toYaml(item, 0)}`;
    }).join("\n");
  }
  if (isPlainObject(obj)) {
    const keys = Object.keys(obj);
    if (!keys.length) return "{}";
    return keys.map(k => {
      const v = obj[k];
      const key = /^[\w.-]+$/.test(k) ? k : JSON.stringify(k);
      if ((isPlainObject(v) && Object.keys(v).length) || (Array.isArray(v) && v.length)) {
        return `${pad}${key}:\n${toYaml(v, indent + 1)}`;
      }
      return `${pad}${key}: ${toYaml(v, 0)}`;
    }).join("\n");
  }
  return String(obj);
}

// ---------------------------------------------------------------------------
// Wall-clock time: minutes since 1970-01-01 00:00 read as UTC
// ---------------------------------------------------------------------------
const DAY = 1440;
const DAYS_SHORT = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
const DAYS_LONG = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août",
  "septembre", "octobre", "novembre", "décembre"];

function wm(text) {
  const [d, t = "00:00"] = String(text).split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  return Math.round(Date.UTC(y, mo - 1, da, h || 0, mi || 0) / 60000);
}
const pad2 = (n) => String(n).padStart(2, "0");
function wDate(m) {
  const d = new Date(m * 60000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function wTime(m) {
  const d = new Date(m * 60000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
const wStr = (m) => `${wDate(m)}T${wTime(m)}`;
const dayOf = (m) => Math.floor(m / DAY) * DAY;
const weekday = (m) => (new Date(m * 60000).getUTCDay() + 6) % 7; // Monday = 0
const mondayOf = (m) => dayOf(m) - weekday(m) * DAY;
function monthStart(m) {
  const d = new Date(m * 60000);
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 60000);
}
function addMonths(m, n) {
  const d = new Date(m * 60000);
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) / 60000);
}
function fmtDay(m, long = false) {
  const d = new Date(m * 60000);
  const w = (long ? DAYS_LONG : DAYS_SHORT)[weekday(m)];
  return `${w} ${d.getUTCDate()}${long ? " " + MONTHS[d.getUTCMonth()] : ""}`;
}
function fmtMonth(m) {
  const d = new Date(m * 60000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function fmtRange(a, b) {
  const da = new Date(a * 60000), db = new Date(b * 60000);
  if (da.getUTCMonth() === db.getUTCMonth()) {
    return `${da.getUTCDate()} – ${db.getUTCDate()} ${MONTHS[db.getUTCMonth()]} ${db.getUTCFullYear()}`;
  }
  return `${da.getUTCDate()} ${MONTHS[da.getUTCMonth()]} – ${db.getUTCDate()} ${MONTHS[db.getUTCMonth()]} ${db.getUTCFullYear()}`;
}

// "Now" as wall-clock minutes in Home Assistant's time zone.
function nowWall(timeZone) {
  return wallOf(new Date(), timeZone);
}
function wallOf(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return wm(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`);
  } catch (e) {
    return Math.round((date.getTime() - date.getTimezoneOffset() * 60000) / 60000);
  }
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------
// Event colors are CSS color names: the iCalendar COLOR property (RFC 7986)
// only accepts those, and other calendar apps can read them.
const EVENT_COLORS = [
  ["sandybrown", "Sable"], ["tomato", "Tomate"], ["hotpink", "Rose"],
  ["mediumpurple", "Violet"], ["cornflowerblue", "Bleu"], ["mediumseagreen", "Vert"],
  ["yellowgreen", "Anis"], ["gold", "Or"], ["silver", "Gris"],
];
const AGENDA_COLORS = ["#1D9E75", "#7F77DD", "#D85A30", "#378ADD", "#D4537E", "#BA7517", "#639922", "#5F5E5A"];
const EVENT_ICONS = [
  "mdi:weather-sunny", "mdi:weather-night", "mdi:briefcase", "mdi:home", "mdi:airplane",
  "mdi:snowflake", "mdi:fire", "mdi:school", "mdi:silverware-fork-knife", "mdi:sprout",
];

function agendaColor(cal, index = 0) {
  return (cal && cal.color) || AGENDA_COLORS[index % AGENDA_COLORS.length];
}

// ---------------------------------------------------------------------------
// Recurrence rules (RRULE) ⇄ form model
// ---------------------------------------------------------------------------
const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/**
 * {freq: none|daily|weekly|monthly|yearly|custom, interval, days[], monthly:
 *  day|nth|last, end: never|until|count, until (date), count, raw}
 * Anything the form can't represent exactly becomes "custom", kept as text.
 */
function parseRrule(rrule, startWall) {
  const base = { freq: "none", interval: 1, days: [weekday(wm(startWall))], monthly: "day",
    end: "never", until: "", count: 10, raw: rrule || "" };
  if (!rrule) return base;
  const parts = Object.fromEntries(rrule.split(";").filter(Boolean).map(p => {
    const [k, v = ""] = p.split("=");
    return [k.toUpperCase(), v];
  }));
  const known = ["FREQ", "INTERVAL", "BYDAY", "UNTIL", "COUNT", "WKST"];
  const custom = { ...base, freq: "custom" };
  if (!Object.keys(parts).every(k => known.includes(k))) return custom;
  const freq = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" }[parts.FREQ];
  if (!freq) return custom;
  const model = { ...base, freq, interval: Number(parts.INTERVAL || 1) };
  if (!(model.interval >= 1)) return custom;
  if (parts.UNTIL) {
    const u = parts.UNTIL;
    model.end = "until";
    model.until = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
  } else if (parts.COUNT) {
    model.end = "count";
    model.count = Number(parts.COUNT);
  }
  if (parts.BYDAY) {
    if (freq === "weekly") {
      const days = parts.BYDAY.split(",").map(d => BYDAY.indexOf(d));
      if (days.some(d => d < 0)) return custom;
      model.days = days.sort();
    } else if (freq === "monthly") {
      const m = /^(-?\d)(MO|TU|WE|TH|FR|SA|SU)$/.exec(parts.BYDAY);
      if (!m) return custom;
      const n = Number(m[1]);
      const startDay = wm(startWall);
      if (BYDAY.indexOf(m[2]) !== weekday(startDay)) return custom;
      if (n === -1) model.monthly = "last";
      else if (n === Math.ceil(new Date(startDay * 60000).getUTCDate() / 7)) model.monthly = "nth";
      else return custom;
    } else return custom;
  }
  return model;
}

function buildRrule(model, startWall, allDay = false) {
  if (model.freq === "none") return null;
  if (model.freq === "custom") return (model.raw || "").trim() || null;
  const parts = [`FREQ=${model.freq.toUpperCase()}`];
  if (model.interval > 1) parts.push(`INTERVAL=${model.interval}`);
  const start = wm(startWall);
  if (model.freq === "weekly" && model.days.length) {
    parts.push(`BYDAY=${model.days.slice().sort().map(d => BYDAY[d]).join(",")}`);
  }
  if (model.freq === "monthly" && model.monthly !== "day") {
    const n = model.monthly === "last" ? -1 : Math.ceil(new Date(start * 60000).getUTCDate() / 7);
    parts.push(`BYDAY=${n}${BYDAY[weekday(start)]}`);
  }
  if (model.end === "until" && model.until) {
    // End of the chosen day, as a floating date-time: the backend localises it.
    // An all-day series takes a date; a timed one the end of the chosen day,
    // as a floating date-time that the backend reads as local time.
    parts.push(`UNTIL=${model.until.replace(/-/g, "")}${allDay ? "" : "T235959"}`);
  } else if (model.end === "count" && model.count > 0) {
    parts.push(`COUNT=${model.count}`);
  }
  return parts.join(";");
}

function describeRrule(rrule, startWall) {
  if (!rrule) return "Une seule fois";
  const m = parseRrule(rrule, startWall);
  if (m.freq === "custom") return `Règle personnalisée (${rrule})`;
  const unit = { daily: ["jour", "jours"], weekly: ["semaine", "semaines"],
    monthly: ["mois", "mois"], yearly: ["an", "ans"] }[m.freq];
  let txt = m.interval > 1 ? `Tous les ${m.interval} ${unit[1]}` :
    { daily: "Chaque jour", weekly: "Chaque semaine", monthly: "Chaque mois", yearly: "Chaque année" }[m.freq];
  if (m.freq === "weekly") {
    const d = m.days.slice().sort();
    if (d.join() === "0,1,2,3,4") txt += ", du lundi au vendredi";
    else if (d.join() === "5,6") txt += ", le week-end";
    else txt += `, le ${d.map(i => DAYS_LONG[i]).join(", ")}`;
  }
  if (m.freq === "monthly") {
    const s = wm(startWall);
    if (m.monthly === "day") txt += `, le ${new Date(s * 60000).getUTCDate()}`;
    else if (m.monthly === "last") txt += `, le dernier ${DAYS_LONG[weekday(s)]}`;
    else txt += `, le ${Math.ceil(new Date(s * 60000).getUTCDate() / 7)}e ${DAYS_LONG[weekday(s)]}`;
  }
  if (m.end === "until") txt += `, jusqu'au ${m.until.split("-").reverse().join("/")}`;
  if (m.end === "count") txt += `, ${m.count} fois`;
  return txt;
}

// ---------------------------------------------------------------------------
// Conditions: same evaluation as actions.py
// ---------------------------------------------------------------------------
const DOMAIN_STATES = {
  binary_sensor: ["on", "off"], switch: ["on", "off"], light: ["on", "off"], fan: ["on", "off"],
  input_boolean: ["on", "off"], automation: ["on", "off"], script: ["on", "off"],
  siren: ["on", "off"], humidifier: ["on", "off"], remote: ["on", "off"],
  person: ["home", "not_home"], device_tracker: ["home", "not_home"],
  cover: ["open", "closed", "opening", "closing"], valve: ["open", "closed", "opening", "closing"],
  lock: ["locked", "unlocked"], sun: ["above_horizon", "below_horizon"],
  vacuum: ["cleaning", "docked", "paused", "idle", "returning", "error"],
  media_player: ["playing", "paused", "idle", "off", "on", "standby"],
  timer: ["active", "paused", "idle"],
};

// Mirrors _expected_state() in actions.py.
function expectedState(v) {
  if (v === true) return "on";
  if (v === false) return "off";
  if (v === null || v === undefined) return "None";
  return String(v);
}

function toNumber(v) {
  return (typeof v === "boolean" || v === null || v === undefined || v === "") ? NaN : Number(v);
}

// Mirrors _check_single_condition() in actions.py.
function evalCondition(cond, states) {
  if (!isPlainObject(cond)) return false;
  const subs = Array.isArray(cond.conditions) ? cond.conditions : [];
  switch (cond.condition) {
    case "state": {
      const st = states[cond.entity_id];
      if (!st) return false;
      if (Array.isArray(cond.state)) return cond.state.map(expectedState).includes(st.state);
      return st.state === expectedState(cond.state);
    }
    case "numeric_state": {
      const st = states[cond.entity_id];
      if (!st) return false;
      const value = toNumber(cond.attribute ? (st.attributes || {})[cond.attribute] : st.state);
      const above = cond.above === undefined || cond.above === null ? null : toNumber(cond.above);
      const below = cond.below === undefined || cond.below === null ? null : toNumber(cond.below);
      if ((above === null && below === null) || Number.isNaN(value) ||
          Number.isNaN(above) || Number.isNaN(below)) return false;
      return (above === null || value > above) && (below === null || value < below);
    }
    case "or": return subs.some(s => evalCondition(s, states));
    case "and": return subs.every(s => evalCondition(s, states));
    case "not": return !subs.some(s => evalCondition(s, states));
    default: return false;
  }
}

// Would this phase run right now?  null when it has no condition.
function phaseConditionsMet(phase, states) {
  if (!isPlainObject(phase)) return null;
  const conds = Array.isArray(phase.conditions) ? phase.conditions : (phase.conditions ? [phase.conditions] : []);
  if (!conds.length) return null;
  return conds.every(c => evalCondition(c, states));
}

function phaseSteps(phase) {
  if (Array.isArray(phase)) return phase;
  if (isPlainObject(phase)) {
    const a = phase.actions;
    return Array.isArray(a) ? a : (a ? [a] : []);
  }
  return [];
}

function phaseConditions(phase) {
  if (!isPlainObject(phase)) return [];
  const c = phase.conditions;
  return Array.isArray(c) ? c : (c ? [c] : []);
}

function knownStates(entityId, stateObj) {
  const attrs = (stateObj && stateObj.attributes) || {};
  const domain = (entityId || "").split(".")[0];
  let list = [];
  if (Array.isArray(attrs.options)) list = attrs.options.map(String);
  else if (domain === "climate" && Array.isArray(attrs.hvac_modes)) list = attrs.hvac_modes.map(String);
  else if (DOMAIN_STATES[domain]) list = DOMAIN_STATES[domain].slice();
  if (stateObj && typeof stateObj.state === "string" && !list.includes(stateObj.state)) list.push(stateObj.state);
  return list;
}

function friendly(hass, entityId) {
  const st = hass && hass.states && hass.states[entityId];
  return (st && st.attributes && st.attributes.friendly_name) || entityId || "";
}

// Template variables offered by the "Insérer" buttons.
const TEMPLATE_VARS = [
  ["nom de l'événement", "{{ event.summary }}"],
  ["agenda", "{{ agenda }}"],
  ["heure de début", "{{ as_datetime(event.start).strftime('%H:%M') }}"],
  ["heure de fin", "{{ as_datetime(event.end).strftime('%H:%M') }}"],
  ["phase", "{{ phase }}"],
];

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const STYLES = `
:host {
  display: block;
  --la-bg: var(--primary-background-color, #fafafa);
  --la-card: var(--card-background-color, #fff);
  --la-soft: var(--secondary-background-color, #f2f2f2);
  --la-text: var(--primary-text-color, #212121);
  --la-text2: var(--secondary-text-color, #727272);
  --la-line: var(--divider-color, rgba(0,0,0,.12));
  --la-accent: var(--primary-color, #03a9f4);
  --la-danger: var(--error-color, #db4437);
  --la-ok: var(--success-color, #43a047);
  --la-warn: var(--warning-color, #ffa600);
  --la-radius: 10px;
  font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
  color: var(--la-text);
  font-size: 14px;
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; cursor: pointer; }
input, select, textarea { font: inherit; color: var(--la-text); background: var(--la-card);
  border: 1px solid var(--la-line); border-radius: 8px; padding: 7px 9px; min-width: 0; }
input:focus, select:focus, textarea:focus { outline: 2px solid var(--la-accent); outline-offset: -1px; }
textarea { width: 100%; resize: vertical; min-height: 60px; }
ha-icon.ic { --mdc-icon-size: 18px; width: 18px; height: 18px; display: inline-flex; flex-shrink: 0; }
.root { display: flex; flex-direction: column; height: 100vh; background: var(--la-bg); }
.toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex-wrap: wrap;
  border-bottom: 1px solid var(--la-line); background: var(--app-header-background-color, var(--la-card));
  color: var(--app-header-text-color, var(--la-text)); }
.toolbar .title { font-size: 18px; font-weight: 500; margin: 0 8px; flex: 1; min-width: 120px; }
.btn { border: 1px solid var(--la-line); background: var(--la-card); border-radius: 18px; padding: 5px 12px;
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.btn:hover { background: var(--la-soft); }
.btn.primary { background: var(--la-accent); border-color: var(--la-accent); color: var(--text-primary-color, #fff); }
.btn.danger { color: var(--la-danger); border-color: transparent; background: transparent; }
.btn.ghost { border-color: transparent; background: transparent; }
.iconbtn { border: none; background: transparent; width: 32px; height: 32px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center; color: var(--la-text2); flex-shrink: 0; }
.iconbtn:hover { background: var(--la-soft); color: var(--la-text); }
.seg { display: inline-flex; border: 1px solid var(--la-line); border-radius: 18px; overflow: hidden; background: var(--la-card); }
.seg button { border: none; background: transparent; padding: 5px 11px; display: inline-flex; gap: 5px; align-items: center; color: var(--la-text2); }
.seg button.on { background: color-mix(in srgb, var(--la-accent) 16%, var(--la-card)); color: var(--la-accent); font-weight: 500; }
.body { flex: 1; display: flex; min-height: 0; }
.side { width: 260px; flex-shrink: 0; border-right: 1px solid var(--la-line); overflow-y: auto; padding: 10px 8px;
  background: var(--la-card); }
.side.drawer { position: absolute; z-index: 20; top: 0; bottom: 0; left: 0; box-shadow: 0 0 24px rgba(0,0,0,.25); }
.main { flex: 1; min-width: 0; position: relative; display: flex; flex-direction: column; }
.calrow { display: flex; gap: 8px; align-items: flex-start; padding: 7px 6px; border-radius: 8px; }
.calrow:hover { background: var(--la-soft); }
.calbox { width: 16px; height: 16px; border-radius: 4px; margin-top: 2px; flex-shrink: 0; cursor: pointer;
  border: 2px solid; display: inline-flex; align-items: center; justify-content: center; color: #fff; }
.calname { font-weight: 500; }
.calstat { color: var(--la-text2); font-size: 12px; }
.calrow.off .calname, .calrow.off .calstat { color: var(--la-text2); opacity: .7; }
.switch { position: relative; width: 34px; height: 20px; border-radius: 10px; background: var(--la-accent);
  flex-shrink: 0; margin-left: auto; border: none; margin-top: 1px; }
.switch::after { content: ""; position: absolute; top: 3px; right: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: right .15s; }
.switch.off { background: var(--la-line); }
.switch.off::after { right: 17px; }
.sidehead { color: var(--la-text2); font-size: 12px; margin: 14px 6px 4px; text-transform: none; }
.link { color: var(--la-accent); background: none; border: none; padding: 6px; display: inline-flex; gap: 6px; align-items: center; }
.pills { display: flex; gap: 6px; padding: 8px 12px 0; overflow-x: auto; }
.pill { border: 1px solid var(--la-line); border-radius: 14px; padding: 3px 10px; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; background: var(--la-card); }
.pill.off { opacity: .5; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.fab { position: absolute; right: 18px; bottom: 18px; z-index: 5; border: none; border-radius: 22px; padding: 11px 18px;
  background: var(--la-accent); color: var(--text-primary-color, #fff); display: inline-flex; gap: 8px; align-items: center;
  box-shadow: 0 3px 10px rgba(0,0,0,.25); font-weight: 500; }
.fab.round { padding: 12px; }
.empty { padding: 40px; text-align: center; color: var(--la-text2); }
.scroll { flex: 1; overflow: auto; position: relative; }

/* Week / day */
.wk-head { display: grid; border-bottom: 1px solid var(--la-line); background: var(--la-card); }
.wk-head .d { text-align: center; padding: 6px 2px; color: var(--la-text2); font-size: 12px; }
.wk-head .d b { display: block; font-size: 18px; font-weight: 500; color: var(--la-text); }
.wk-head .d.today, .wk-head .d.today b { color: var(--la-accent); }
.wk-allday { display: grid; border-bottom: 1px solid var(--la-line); background: var(--la-card); min-height: 4px; }
.wk-allday .cell { padding: 2px; display: flex; flex-direction: column; gap: 2px; border-left: 1px solid var(--la-line); }
.wk-grid { display: grid; position: relative; }
.wk-hours { position: relative; }
.wk-hours span { position: absolute; right: 6px; font-size: 11px; color: var(--la-text2); transform: translateY(-50%); }
.wk-col { position: relative; border-left: 1px solid var(--la-line);
  background-image: repeating-linear-gradient(to bottom, var(--la-line) 0, var(--la-line) 1px, transparent 1px, transparent var(--hour)); }
.wk-col.today { background-color: color-mix(in srgb, var(--la-accent) 5%, transparent); }
.ev { position: absolute; border-radius: 6px; padding: 2px 5px 2px 7px; overflow: hidden; font-size: 12px; line-height: 1.25;
  border-left: 4px solid var(--agenda); background: color-mix(in srgb, var(--evc) 30%, var(--la-card));
  border-top: 1px solid color-mix(in srgb, var(--evc) 60%, var(--la-card)); cursor: pointer; user-select: none; touch-action: pan-y; }
.ev:hover { box-shadow: 0 1px 6px rgba(0,0,0,.2); z-index: 3; }
.ev .t { font-weight: 500; }
.ev .h { color: var(--la-text2); font-size: 11px; }
.ev .marks { position: absolute; right: 3px; bottom: 2px; display: flex; gap: 1px; color: var(--la-text2); }
.ev .marks ha-icon { --mdc-icon-size: 13px; width: 13px; height: 13px; }
.ev.ko { background: repeating-linear-gradient(135deg, var(--la-soft) 0 5px, var(--la-card) 5px 10px); color: var(--la-text2); }
.ev.ko .t { text-decoration: line-through; }
.ev.susp { opacity: .55; }
.ev.other { border-left-color: var(--la-text2); background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--evc) 18%, var(--la-card)) 0 5px, var(--la-card) 5px 10px);
  border: 1px dashed color-mix(in srgb, var(--evc) 70%, var(--la-card)); cursor: default; }
.ev .resize { position: absolute; left: 0; right: 0; bottom: 0; height: 7px; cursor: ns-resize; touch-action: none; }
.ev.dragging { opacity: .85; box-shadow: 0 4px 14px rgba(0,0,0,.3); z-index: 10; }
.chip-ev { border-radius: 5px; padding: 1px 5px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border-left: 3px solid var(--agenda); background: color-mix(in srgb, var(--evc) 30%, var(--la-card)); cursor: pointer; }
.chip-ev.other { border-left-color: var(--la-text2); background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--evc) 18%, var(--la-card)) 0 4px, var(--la-card) 4px 8px); cursor: default; }
.nowline { position: absolute; left: 0; right: 0; border-top: 2px solid var(--la-danger); z-index: 4; pointer-events: none; }
.nowline::before { content: ""; position: absolute; left: -5px; top: -6px; width: 10px; height: 10px; border-radius: 50%; background: var(--la-danger); }
.nowline.vertical::before { display: none; }

/* Month */
.mo { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); grid-auto-rows: minmax(96px, 1fr); }
.mo .hd { text-align: center; font-size: 12px; color: var(--la-text2); padding: 6px; border-bottom: 1px solid var(--la-line); }
.mo .c { border-right: 1px solid var(--la-line); border-bottom: 1px solid var(--la-line); padding: 3px; display: flex; flex-direction: column; gap: 2px; min-width: 0; cursor: pointer; }
.mo .c.out { background: var(--la-soft); }
.mo .c .n { font-size: 12px; color: var(--la-text2); align-self: flex-start; padding: 1px 5px; border-radius: 10px; }
.mo .c.today .n { background: var(--la-accent); color: var(--text-primary-color, #fff); }
.mo .more { font-size: 11px; color: var(--la-text2); padding-left: 4px; }

/* House */
.house { padding: 10px 12px 80px; }
.hs-row { display: grid; grid-template-columns: 170px minmax(0, 1fr); gap: 10px; align-items: center; padding: 5px 0; }
.hs-name { display: flex; flex-direction: column; min-width: 0; }
.hs-name .calname { display: flex; gap: 7px; align-items: center; }
.hs-lane { position: relative; border-radius: 8px; background-color: var(--la-soft);
  background-image: repeating-linear-gradient(90deg, transparent 0, transparent calc(12.5% - 1px), var(--la-line) calc(12.5% - 1px), var(--la-line) 12.5%); }
.hs-b { position: absolute; height: 26px; border-radius: 6px; padding: 0 7px; display: flex; align-items: center; font-size: 12px;
  white-space: nowrap; overflow: hidden; border-left: 3px solid var(--agenda); background: color-mix(in srgb, var(--evc) 32%, var(--la-card)); cursor: pointer; }
.hs-b span { overflow: hidden; text-overflow: ellipsis; }
.hs-b.other { border: 1px dashed color-mix(in srgb, var(--evc) 70%, var(--la-card)); background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--evc) 22%, var(--la-card)) 0 5px, var(--la-card) 5px 10px); cursor: default; justify-content: center; }
.hs-axis { position: relative; height: 18px; font-size: 11px; color: var(--la-text2); }
.hs-sep { border-top: 1px solid var(--la-line); margin: 8px 0; }

/* List / executions */
.list { padding: 10px 14px 80px; max-width: 900px; }
.lgroup { margin: 12px 0 4px; display: flex; gap: 8px; align-items: center; font-weight: 500; }
.litem { display: grid; grid-template-columns: 54px 12px minmax(0, 1fr) auto; gap: 10px; align-items: center;
  padding: 8px 10px; border: 1px solid var(--la-line); border-radius: 8px; background: var(--la-card); margin-top: 6px; cursor: pointer; }
.litem:hover { background: var(--la-soft); }
.litem .sub { color: var(--la-text2); font-size: 12px; }
.tag { border-radius: 10px; padding: 1px 8px; font-size: 11px; white-space: nowrap; background: var(--la-soft); color: var(--la-text2); }
.tag.ok { background: color-mix(in srgb, var(--la-ok) 18%, var(--la-card)); color: var(--la-ok); }
.tag.ko { background: color-mix(in srgb, var(--la-warn) 22%, var(--la-card)); color: color-mix(in srgb, var(--la-warn) 70%, var(--la-text)); }
.tag.err { background: color-mix(in srgb, var(--la-danger) 16%, var(--la-card)); color: var(--la-danger); }
.tag.info { background: color-mix(in srgb, var(--la-accent) 16%, var(--la-card)); color: var(--la-accent); }

/* Dialog */
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 50; display: flex; align-items: flex-start; justify-content: center; overflow-y: auto; padding: 24px 12px; }
.dialog { background: var(--la-card); border-radius: 14px; width: 100%; max-width: 640px; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
.dialog.small { max-width: 400px; }
.dlg-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 8px; }
.dlg-head .ttl { font-size: 18px; font-weight: 500; flex: 1; }
.dlg-sec { padding: 10px 16px; }
.dlg-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--la-line);
  position: sticky; bottom: 0; background: var(--la-card); border-radius: 0 0 14px 14px; }
.lbl { font-size: 12px; color: var(--la-text2); margin: 0 0 4px; display: block; }
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.full { width: 100%; }
.scope { margin: 0 16px 6px; background: var(--la-soft); border-radius: 10px; padding: 8px 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.colors { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
.sw { width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--la-line); padding: 0; }
.sw.on { box-shadow: 0 0 0 2px var(--la-card), 0 0 0 4px var(--la-text); }
.daychips { display: flex; gap: 5px; flex-wrap: wrap; }
.dchip { width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--la-line); background: var(--la-card); }
.dchip.on { background: var(--la-accent); color: var(--text-primary-color, #fff); border-color: var(--la-accent); }
.mono { font-family: var(--code-font-family, monospace); font-size: 12px; color: var(--la-text2); }
.err-box { margin: 8px 16px 0; padding: 8px 10px; border-radius: 8px; color: var(--la-danger);
  background: color-mix(in srgb, var(--la-danger) 10%, var(--la-card)); white-space: pre-wrap; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

/* Phase sections and cards (start / end rules) */
.phase { border: 1px solid var(--la-line); border-radius: 12px; margin: 8px 16px; overflow: hidden; }
.phase > .hd, .card > .hd { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; user-select: none; }
.phase > .hd:hover, .card > .hd:hover { background: var(--la-soft); }
.phase > .hd .name { font-weight: 500; }
.phase > .hd .sum, .card > .hd .sum { color: var(--la-text2); font-size: 12px; }
.phase .bd { padding: 4px 12px 12px; border-top: 1px solid var(--la-line); }
.phase:not(.open) .bd, .card:not(.open) > .bd { display: none; }
.chev { color: var(--la-text); flex-shrink: 0; transition: transform .15s; }
.open > .hd .chev { transform: rotate(180deg); }
.sepv { width: 1px; height: 20px; background: var(--la-line); margin: 0 2px; flex-shrink: 0; }
.subhead { display: flex; align-items: center; gap: 8px; margin: 12px 0 4px; flex-wrap: wrap; }
.subhead .t { font-weight: 500; }
.card { border: 1px solid var(--la-line); border-radius: 9px; margin-top: 6px; background: var(--la-card); overflow: hidden; }
.card.open { border-color: color-mix(in srgb, var(--la-text) 25%, var(--la-card)); }
.card.open > .hd { background: var(--la-soft); border-bottom: 1px solid var(--la-line); }
.card > .bd { padding: 8px 12px 12px 22px; margin: 6px 0 6px 12px; border-left: 2px solid var(--la-accent); display: flex; flex-direction: column; gap: 8px; }
.card .num { width: 20px; height: 20px; border-radius: 50%; background: color-mix(in srgb, var(--la-accent) 16%, var(--la-card));
  color: var(--la-accent); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; flex-shrink: 0; }
.card .ttl { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.card .ttl b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .ttl .sum { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card.open .ttl .sum { display: none; }
.grip { cursor: grab; touch-action: none; color: var(--la-text2); }
.card.moving { opacity: .6; outline: 2px dashed var(--la-accent); }
.card.flash { animation: laflash 1.6s ease-out; }
@keyframes laflash { from { background: color-mix(in srgb, var(--la-accent) 22%, var(--la-card)); } to { background: var(--la-card); } }
.copytag { font-size: 11px; color: var(--la-accent); background: color-mix(in srgb, var(--la-accent) 14%, var(--la-card)); border-radius: 8px; padding: 0 6px; margin-left: 6px; font-weight: 400; }
.badge { border-radius: 10px; padding: 1px 8px; font-size: 11px; white-space: nowrap; }
.badge.ok { background: color-mix(in srgb, var(--la-ok) 18%, var(--la-card)); color: var(--la-ok); }
.badge.ko { background: color-mix(in srgb, var(--la-danger) 14%, var(--la-card)); color: var(--la-danger); }
.badge.warn { background: color-mix(in srgb, var(--la-warn) 22%, var(--la-card)); color: color-mix(in srgb, var(--la-warn) 70%, var(--la-text)); }
.stchips { display: flex; flex-wrap: wrap; gap: 5px; }
.stchip { border: 1px solid var(--la-line); border-radius: 14px; padding: 3px 10px; background: var(--la-card); font-size: 12px; }
.stchip.on { background: color-mix(in srgb, var(--la-accent) 18%, var(--la-card)); border-color: var(--la-accent); color: var(--la-accent); }
.hint { color: var(--la-text2); font-size: 12px; }
.addbtn { margin-top: 8px; border: 1px solid color-mix(in srgb, var(--la-accent) 50%, var(--la-card)); color: var(--la-accent);
  background: var(--la-card); border-radius: 8px; padding: 5px 10px; display: inline-flex; gap: 6px; align-items: center; }
.menu { position: absolute; z-index: 60; background: var(--la-card); border: 1px solid var(--la-line); border-radius: 10px;
  box-shadow: 0 6px 20px rgba(0,0,0,.2); padding: 4px 0; min-width: 230px; }
.menu button { display: flex; width: 100%; gap: 10px; align-items: center; border: none; background: none; padding: 8px 14px; text-align: left; }
.menu button:hover { background: var(--la-soft); }
.menu .sep { border-top: 1px solid var(--la-line); margin: 4px 0; }
.ac { position: relative; }
.ac-list { position: absolute; z-index: 70; left: 0; right: 0; top: 100%; max-height: 260px; overflow-y: auto; background: var(--la-card);
  border: 1px solid var(--la-line); border-radius: 8px; box-shadow: 0 6px 18px rgba(0,0,0,.18); }
.ac-item { padding: 6px 10px; cursor: pointer; display: flex; flex-direction: column; }
.ac-item small { color: var(--la-text2); }
.ac-item.on, .ac-item:hover { background: var(--la-soft); }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 90; background: #323232; color: #fff;
  border-radius: 8px; padding: 10px 14px; display: flex; gap: 14px; align-items: center; box-shadow: 0 4px 14px rgba(0,0,0,.3); max-width: 92vw; }
.toast button { background: none; border: none; color: #8ecbff; font-weight: 500; }
.toast.error { background: var(--la-danger); }
@media (max-width: 700px) {
  .grid3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .hs-row { grid-template-columns: 110px minmax(0, 1fr); }
  .toolbar .title { font-size: 16px; }
  .overlay { padding: 0; }
  .dialog { border-radius: 0; min-height: 100vh; }
  .grid2 { grid-template-columns: minmax(0, 1fr); }
  .dlg-foot { flex-wrap: wrap; }
  .dlg-foot .btn { padding: 5px 9px; }
  .card > .bd { padding-left: 12px; margin-left: 4px; }
}
`;

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

// Entity picker: shows friendly names, stores the entity_id.
function entityPicker(hass, { value = "", domains = null, placeholder = "Choisir une entité", onChange } = {}) {
  let current = value || "";
  const input = el("input", { type: "text", placeholder, class: "full" });
  const list = el("div", { class: "ac-list", style: "display:none" });
  const root = el("div", { class: "ac" }, input, list);
  let shown = [];
  let active = -1;

  const all = () => Object.keys(hass.states || {})
    .filter(id => !domains || domains.includes(id.split(".")[0]))
    .map(id => ({ id, name: friendly(hass, id) }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));

  function display() { input.value = current ? friendly(hass, current) : ""; input.title = current; }
  function open() {
    const f = input.value.trim().toLowerCase();
    const full = current && input.value === friendly(hass, current);
    shown = all().filter(e => full || !f || e.name.toLowerCase().includes(f) || e.id.includes(f)).slice(0, 80);
    active = -1;
    list.innerHTML = "";
    for (const [i, e] of shown.entries()) {
      const item = el("div", { class: "ac-item", onmousedown: (ev) => { ev.preventDefault(); choose(e.id); } },
        el("span", { text: e.name }), el("small", { text: e.id }));
      item.addEventListener("mouseenter", () => { active = i; mark(); });
      list.append(item);
    }
    list.style.display = shown.length ? "block" : "none";
  }
  function mark() { [...list.children].forEach((c, i) => c.classList.toggle("on", i === active)); }
  function choose(id) {
    current = id;
    display();
    list.style.display = "none";
    onChange && onChange(id);
  }
  input.addEventListener("focus", () => { input.select(); open(); });
  input.addEventListener("input", open);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, shown.length - 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); mark(); }
    else if (e.key === "Enter") { e.preventDefault(); if (active >= 0) choose(shown[active].id); else if (shown.length === 1) choose(shown[0].id); }
    else if (e.key === "Escape") list.style.display = "none";
  });
  input.addEventListener("blur", () => setTimeout(() => {
    list.style.display = "none";
    const typed = input.value.trim();
    // An entity_id typed by hand is accepted as is.
    if (typed && /^[a-z_]+\.[a-z0-9_]+$/.test(typed) && typed !== current) { choose(typed); return; }
    if (!typed && current) { current = ""; onChange && onChange(""); }
    display();
  }, 150));
  display();
  return { root, get value() { return current; }, set(v) { current = v || ""; display(); } };
}

function selectEl(options, value, onChange) {
  const s = el("select", { onchange: () => onChange && onChange(s.value) });
  for (const [v, label] of options) s.append(el("option", { value: v, text: label }));
  s.value = value;
  return s;
}

function segmented(options, value, onChange) {
  const root = el("div", { class: "seg" });
  const buttons = options.map(([v, label, ic]) => {
    const b = el("button", { type: "button", class: v === value ? "on" : "" }, ic ? icon(ic) : null, label);
    b.addEventListener("click", () => { buttons.forEach(x => x.classList.remove("on")); b.classList.add("on"); onChange(v); });
    root.append(b);
    return b;
  });
  return root;
}

// Inserts text at the cursor of an input or textarea.
function insertAtCursor(field, text) {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.value = field.value.slice(0, start) + text + field.value.slice(end);
  field.selectionStart = field.selectionEnd = start + text.length;
  field.focus();
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

// Live preview of a template, rendered by Home Assistant itself.
function templatePreview(hass, getText, getVariables) {
  const out = el("div", { class: "hint" });
  let unsub = null;
  let timer = null;
  async function render() {
    if (unsub) { try { (await unsub)(); } catch (e) { /* closed */ } unsub = null; }
    const text = getText();
    if (!text || !/{[{%]/.test(text)) { out.textContent = text ? `Aperçu : « ${text} »` : ""; return; }
    if (!hass.connection) return;
    unsub = hass.connection.subscribeMessage((msg) => {
      if (msg.error) out.textContent = `Modèle en erreur : ${msg.error}`;
      else if (msg.result !== undefined) out.textContent = `Aperçu : « ${msg.result} »`;
    }, { type: "render_template", template: text, variables: getVariables(), report_errors: true, timeout: 3 })
      .catch((e) => { out.textContent = `Modèle en erreur : ${e.message || e}`; return () => {}; });
  }
  return {
    root: out,
    update() { clearTimeout(timer); timer = setTimeout(render, 400); },
    async close() { clearTimeout(timer); if (unsub) { try { (await unsub)(); } catch (e) { /* closed */ } } },
  };
}

// Pop-up menu anchored under an element of the shadow root.
function popMenu(host, anchor, items) {
  host.querySelectorAll(".menu").forEach(m => m.remove());
  const menu = el("div", { class: "menu" });
  for (const it of items) {
    if (it === "-") { menu.append(el("div", { class: "sep" })); continue; }
    menu.append(el("button", { type: "button", onclick: () => { menu.remove(); it.action(); } },
      it.icon ? icon(it.icon) : null, el("span", { text: it.label }),
      it.hint ? el("small", { class: "hint", style: "margin-left:auto", text: it.hint }) : null));
  }
  const r = anchor.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect ? host.getBoundingClientRect() : { left: 0, top: 0 };
  menu.style.left = `${Math.max(4, Math.min(r.left - hostRect.left, window.innerWidth - 260))}px`;
  menu.style.top = `${r.bottom - hostRect.top + 4}px`;
  host.append(menu);
  const close = (e) => { if (!menu.contains(e.composedPath()[0])) { menu.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  return menu;
}

// ---------------------------------------------------------------------------
// Card list: actions or conditions, with reorder, copy, delete (undo), fold
// ---------------------------------------------------------------------------
/**
 * Each card is {root, read(), error(), refresh?(), open(bool)}.  `factory(data,
 * list)` builds one; `shell()` gives it the common header: grip on the left,
 * then number, icon, title and summary, then copy, delete and the chevron.
 */
class CardList {
  constructor({ factory, onChange, toast, noun }) {
    this.factory = factory;
    this.onChange = onChange || (() => {});
    this.toast = toast;
    this.noun = noun; // "Action" / "Condition"
    this.root = el("div");
    this.cards = [];
  }
  add(data, { open = false, after = null, copy = false } = {}) {
    const card = this.factory(data, this);
    card.list = this;
    const index = after ? this.cards.indexOf(after) + 1 : this.cards.length;
    this.cards.splice(index, 0, card);
    const ref = this.cards[index + 1];
    if (ref) this.root.insertBefore(card.root, ref.root); else this.root.append(card.root);
    card.open(open);
    if (copy) {
      card.root.classList.add("flash");
      card.titleEl && card.titleEl.append(el("span", { class: "copytag", text: "copie" }));
    }
    this.renumber();
    return card;
  }
  copy(card) {
    this.add(deepCopy(card.read()), { open: true, after: card, copy: true });
    this.onChange();
  }
  remove(card) {
    const index = this.cards.indexOf(card);
    this.cards.splice(index, 1);
    card.root.remove();
    this.renumber();
    this.onChange();
    this.toast && this.toast(`${this.noun} « ${card.label()} » supprimée`, "Annuler", () => {
      this.cards.splice(index, 0, card);
      const ref = this.cards[index + 1];
      if (ref) this.root.insertBefore(card.root, ref.root); else this.root.append(card.root);
      this.renumber();
      this.onChange();
    });
  }
  renumber() { this.cards.forEach((c, i) => c.numEl && (c.numEl.textContent = String(i + 1))); }
  read() { return this.cards.map(c => c.read()).filter(v => v !== null && v !== undefined); }
  errors() { return this.cards.map((c, i) => { const e = c.error(); return e ? `${this.noun} ${i + 1} : ${e}` : null; }).filter(Boolean); }
  refresh() { this.cards.forEach(c => c.refresh && c.refresh()); }
  setAll(open) { this.cards.forEach(c => c.open(open)); }
  allOpen() { return this.cards.length > 0 && this.cards.every(c => c.isOpen()); }

  // Common header and folding for a card.
  shell(card, { iconName, title, summary, body, extra }) {
    const numEl = el("span", { class: "num" });
    const titleB = el("b", { text: title });
    const sumEl = el("span", { class: "sum", text: summary || "" });
    const grip = el("span", { class: "grip iconbtn", title: "Déplacer", "aria-label": "Déplacer" }, icon("mdi:drag-vertical"));
    const copyBtn = el("button", { type: "button", class: "iconbtn", title: "Dupliquer", "aria-label": "Dupliquer" }, icon("mdi:content-copy"));
    const delBtn = el("button", { type: "button", class: "iconbtn", title: "Supprimer", "aria-label": "Supprimer", style: "color:var(--la-danger)" }, icon("mdi:delete-outline"));
    const chev = icon("mdi:chevron-down", "chev");
    const hd = el("div", { class: "hd", role: "button", tabindex: "0" },
      grip, numEl, iconName ? icon(iconName) : null, el("div", { class: "ttl" }, titleB, sumEl),
      extra || null, copyBtn, delBtn, el("span", { class: "sepv" }), chev);
    const bd = el("div", { class: "bd" }, body);
    const root = el("div", { class: "card" }, hd, bd);
    Object.assign(card, {
      root, numEl, titleEl: titleB,
      isOpen: () => root.classList.contains("open"),
      open: (o) => { root.classList.toggle("open", o); hd.setAttribute("aria-expanded", String(o)); },
      setTitle: (t) => { titleB.firstChild ? (titleB.firstChild.textContent = t) : (titleB.textContent = t); },
      setSummary: (s) => { sumEl.textContent = s; },
      label: () => titleB.firstChild ? titleB.firstChild.textContent : "",
    });
    hd.addEventListener("click", (e) => {
      if (e.target.closest(".iconbtn")) return;
      card.open(!card.isOpen());
      this.onFold && this.onFold();
    });
    hd.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === hd) { e.preventDefault(); card.open(!card.isOpen()); this.onFold && this.onFold(); }
    });
    copyBtn.addEventListener("click", () => this.copy(card));
    delBtn.addEventListener("click", () => this.remove(card));
    this._wireGrip(card, grip);
    return card;
  }

  _wireGrip(card, grip) {
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
      card.root.classList.add("moving");
      const move = (ev) => {
        const others = this.cards.filter(c => c !== card);
        let index = others.length;
        for (const [i, c] of others.entries()) {
          const r = c.root.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) { index = i; break; }
        }
        const ref = others[index];
        if (ref) this.root.insertBefore(card.root, ref.root); else this.root.append(card.root);
        this.cards = [...others.slice(0, index), card, ...others.slice(index)];
        this.renumber();
      };
      const up = () => {
        card.root.classList.remove("moving");
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        this.onChange();
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });
  }
}

// ---------------------------------------------------------------------------
// Rules: condition and action cards
// ---------------------------------------------------------------------------
// A card is only offered as a form when the form can write back exactly what
// was read; anything else is a YAML card, kept verbatim.

function yamlCard(list, ctx, data, { iconName, title }) {
  const card = {};
  let value = deepCopy(data);
  let err = null;
  const area = el("textarea", { class: "mono", rows: "6", spellcheck: "false" });
  area.value = value === null || value === undefined ? "" : toYaml(value);
  const msg = el("div", { class: "hint" });
  async function parse() {
    const text = area.value.trim();
    if (!text) { value = null; err = "vide"; msg.textContent = ""; return; }
    try {
      const res = await ctx.ws({ type: "local_agenda/yaml/parse", text });
      value = res.data;
      err = null;
      msg.textContent = "";
      card.setSummary(text.split("\n")[0]);
      list.onChange();
    } catch (e) {
      err = `YAML invalide (${e.message || e})`;
      msg.textContent = err;
    }
  }
  area.addEventListener("change", parse);
  area.addEventListener("input", () => { err = "en cours de saisie"; });
  area.addEventListener("blur", parse);
  list.shell(card, {
    iconName: iconName || "mdi:code-braces", title: title || "YAML",
    summary: area.value.split("\n")[0], body: [area, msg],
  });
  card.read = () => value;
  card.error = () => (err && err !== "en cours de saisie" ? err : (err ? "YAML non validé" : null));
  card.refresh = () => {};
  // Called before saving: a YAML typed but not yet left must still count.
  card.flush = () => (err === "en cours de saisie" ? parse() : Promise.resolve());
  return card;
}

// ---------------- Conditions ----------------

function parseCondition(cond) {
  if (!isPlainObject(cond)) return { kind: "yaml", data: cond };
  let c = cond;
  let negate = false;
  if (c.condition === "not" && hasOnlyKeys(c, ["condition", "conditions"]) &&
      Array.isArray(c.conditions) && c.conditions.length === 1 && isPlainObject(c.conditions[0])) {
    negate = true;
    c = c.conditions[0];
  }
  if (c.condition === "state" && hasOnlyKeys(c, ["condition", "entity_id", "state"]) && typeof c.entity_id === "string") {
    const states = Array.isArray(c.state) ? c.state : (c.state === undefined || c.state === "" ? [] : [c.state]);
    if (states.every(s => ["string", "boolean", "number"].includes(typeof s))) {
      return { kind: "state", entity: c.entity_id, states: states.map(expectedState), negate };
    }
  }
  if (!negate && c.condition === "numeric_state" && typeof c.entity_id === "string" &&
      hasOnlyKeys(c, ["condition", "entity_id", "above", "below", "attribute"])) {
    const ok = (v) => v === undefined || v === null || !Number.isNaN(toNumber(v));
    if (ok(c.above) && ok(c.below) && (c.attribute === undefined || typeof c.attribute === "string")) {
      return { kind: "numeric", entity: c.entity_id, above: c.above ?? null, below: c.below ?? null, attribute: c.attribute || "" };
    }
  }
  return { kind: "yaml", data: cond };
}

function conditionLabel(hass, cond) {
  const m = parseCondition(cond);
  if (m.kind === "state") return `${friendly(hass, m.entity) || "(entité)"} ${m.negate ? "n'est pas" : "est"} ${m.states.join(", ") || "(état)"}`;
  if (m.kind === "numeric") {
    const what = m.attribute ? `${friendly(hass, m.entity)} (${m.attribute})` : friendly(hass, m.entity);
    if (m.above !== null && m.below !== null) return `${what} entre ${m.above} et ${m.below}`;
    if (m.above !== null) return `${what} au-dessus de ${m.above}`;
    return `${what} en dessous de ${m.below}`;
  }
  return "Condition avancée";
}

function conditionFactory(ctx) {
  return (data, list) => {
    const m = data ? parseCondition(data) : { kind: ctx.newKind || "state", entity: "", states: [], negate: false, above: null, below: null, attribute: "" };
    if (m.kind === "state") return stateConditionCard(list, ctx, m);
    if (m.kind === "numeric") return numericConditionCard(list, ctx, m);
    const card = yamlCard(list, ctx, m.data, { iconName: "mdi:code-braces", title: "Condition avancée" });
    const badge = el("span", { class: "badge" });
    card.root.querySelector(".hd").insertBefore(badge, card.root.querySelector(".hd .iconbtn:not(.grip)"));
    card.refresh = () => {
      const v = card.read();
      if (v === null) { badge.className = "badge"; badge.textContent = ""; return; }
      const met = evalCondition(v, ctx.states());
      badge.className = `badge ${met ? "ok" : "ko"}`;
      badge.textContent = met ? "remplie" : "non remplie";
    };
    card.refresh();
    return card;
  };
}

function stateConditionCard(list, ctx, m) {
  const card = {};
  const hass = ctx.hass;
  const selected = m.states.slice();
  const badge = el("span", { class: "badge" });
  const current = el("div", { class: "hint" });
  const chips = el("div", { class: "stchips" });
  const other = el("input", { type: "text", placeholder: "Autre état", style: "width:140px" });
  const picker = entityPicker(hass, { value: m.entity, onChange: () => { renderChips(); update(); } });
  const cmp = selectEl([["is", "est"], ["not", "n'est pas"]], m.negate ? "not" : "is", () => update());
  function renderChips() {
    const st = ctx.states()[picker.value];
    const known = knownStates(picker.value, st);
    selected.forEach(s => { if (!known.includes(s)) known.push(s); });
    chips.innerHTML = "";
    if (!known.length) chips.append(el("span", { class: "hint", text: picker.value ? "Aucun état connu : ajoutez-le ci-dessous." : "Choisissez d'abord une entité." }));
    for (const s of known) {
      chips.append(el("button", {
        type: "button", class: `stchip ${selected.includes(s) ? "on" : ""}`, text: s,
        onclick: () => { const i = selected.indexOf(s); if (i < 0) selected.push(s); else selected.splice(i, 1); renderChips(); update(); },
      }));
    }
  }
  const addOther = () => { const v = other.value.trim(); if (v && !selected.includes(v)) selected.push(v); other.value = ""; renderChips(); update(); };
  other.addEventListener("change", addOther);
  function read() {
    if (!picker.value && !selected.length) return null;
    const c = { condition: "state", entity_id: picker.value, state: selected.length === 1 ? selected[0] : selected.slice() };
    return cmp.value === "not" ? { condition: "not", conditions: [c] } : c;
  }
  function update() {
    const st = ctx.states()[picker.value];
    current.textContent = st ? `Actuellement : ${st.state}` : (picker.value ? "Entité inconnue de Home Assistant" : "");
    const c = read();
    card.setSummary && card.setSummary(c ? conditionLabel(hass, c) : "");
    card.setTitle && card.setTitle(picker.value ? friendly(hass, picker.value) : "État d'une entité");
    if (!c || card.error()) { badge.className = "badge warn"; badge.textContent = c ? "incomplète" : ""; }
    else { const met = evalCondition(c, ctx.states()); badge.className = `badge ${met ? "ok" : "ko"}`; badge.textContent = met ? "remplie" : "non remplie"; }
    list.onChange();
  }
  list.shell(card, {
    iconName: "mdi:list-status", title: m.entity ? friendly(hass, m.entity) : "État d'une entité", summary: "", extra: badge,
    body: [
      el("div", { class: "grid2", style: "grid-template-columns:minmax(0,2fr) minmax(0,1fr)" },
        el("div", {}, el("span", { class: "lbl", text: "Entité" }), picker.root, current),
        el("div", {}, el("span", { class: "lbl", text: "Comparaison" }), cmp)),
      el("div", {}, el("span", { class: "lbl", text: "États (choix multiple)" }), chips),
      el("div", { class: "row" }, other, el("button", { type: "button", class: "btn", text: "Ajouter", onclick: addOther })),
    ],
  });
  card.read = read;
  card.error = () => {
    if (!picker.value && !selected.length) return null;
    if (!picker.value) return "choisissez une entité";
    if (!selected.length) return "choisissez au moins un état";
    return null;
  };
  card.refresh = () => update();
  renderChips();
  update();
  return card;
}

function numericConditionCard(list, ctx, m) {
  const card = {};
  const hass = ctx.hass;
  const badge = el("span", { class: "badge" });
  const current = el("div", { class: "hint" });
  const op = m.above !== null && m.below !== null ? "between" : (m.above !== null ? "above" : "below");
  const a = el("input", { type: "number", step: "any", style: "width:90px", value: m.above ?? "" });
  const b = el("input", { type: "number", step: "any", style: "width:90px", value: m.below ?? "" });
  const andLbl = el("span", { text: "et" });
  const cmp = selectEl([["above", "au-dessus de"], ["below", "en dessous de"], ["between", "entre"]], op, () => { layout(); update(); });
  const attr = el("select");
  const picker = entityPicker(hass, { value: m.entity, onChange: () => { fillAttrs(); update(); } });
  function fillAttrs() {
    const st = ctx.states()[picker.value];
    const keep = attr.value || m.attribute;
    attr.innerHTML = "";
    attr.append(el("option", { value: "", text: "État de l'entité" }));
    const attrs = (st && st.attributes) || {};
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v === "number" || (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)))) attr.append(el("option", { value: k, text: k }));
    }
    if (keep && ![...attr.options].some(o => o.value === keep)) attr.append(el("option", { value: keep, text: keep }));
    attr.value = keep || "";
  }
  function layout() {
    const v = cmp.value;
    a.style.display = v === "below" ? "none" : "";
    b.style.display = v === "above" ? "none" : "";
    andLbl.style.display = v === "between" ? "" : "none";
  }
  function read() {
    if (!picker.value) return null;
    const c = { condition: "numeric_state", entity_id: picker.value };
    if (attr.value) c.attribute = attr.value;
    if (cmp.value !== "below" && a.value !== "") c.above = Number(a.value);
    if (cmp.value !== "above" && b.value !== "") c.below = Number(b.value);
    return c;
  }
  function update() {
    const st = ctx.states()[picker.value];
    const raw = st ? (attr.value ? (st.attributes || {})[attr.value] : st.state) : undefined;
    const unit = st && !attr.value ? (st.attributes || {}).unit_of_measurement || "" : "";
    current.textContent = st ? `Actuellement : ${raw ?? "—"} ${unit}`.trim() : (picker.value ? "Entité inconnue de Home Assistant" : "");
    const c = read();
    card.setTitle && card.setTitle(picker.value ? friendly(hass, picker.value) : "Valeur numérique");
    card.setSummary && card.setSummary(c ? conditionLabel(hass, c) : "");
    if (!c || card.error()) { badge.className = "badge warn"; badge.textContent = c ? "incomplète" : ""; }
    else { const met = evalCondition(c, ctx.states()); badge.className = `badge ${met ? "ok" : "ko"}`; badge.textContent = met ? "remplie" : "non remplie"; }
    list.onChange();
  }
  [a, b, attr].forEach(x => x.addEventListener("input", update));
  attr.addEventListener("change", update);
  list.shell(card, {
    iconName: "mdi:gauge", title: m.entity ? friendly(hass, m.entity) : "Valeur numérique", summary: "", extra: badge,
    body: [
      el("div", {}, el("span", { class: "lbl", text: "Entité" }), picker.root, current),
      el("div", { class: "row" }, el("span", { class: "lbl", style: "margin:0", text: "Valeur" }), attr),
      el("div", { class: "row" }, cmp, a, andLbl, b),
    ],
  });
  card.read = read;
  card.error = () => {
    if (!picker.value) return a.value || b.value ? "choisissez une entité" : null;
    const c = read();
    if (c.above === undefined && c.below === undefined) return "indiquez un seuil";
    if (c.above !== undefined && c.below !== undefined && c.above >= c.below) return "le premier seuil doit être inférieur au second";
    return null;
  };
  card.refresh = () => update();
  fillAttrs();
  layout();
  update();
  return card;
}

// ---------------- Actions ----------------

const SWITCH_DOMAINS = ["switch", "light", "input_boolean", "fan", "humidifier", "siren", "automation", "climate", "media_player"];

function parseDelay(v) {
  if (typeof v === "number" && v >= 0) return { value: v, unit: "seconds" };
  if (typeof v === "string" && /^\d{1,2}:\d{2}(:\d{2})?$/.test(v)) {
    const [h, m, s = 0] = v.split(":").map(Number);
    const total = h * 3600 + m * 60 + s;
    if (total % 3600 === 0 && total) return { value: total / 3600, unit: "hours" };
    if (total % 60 === 0) return { value: total / 60, unit: "minutes" };
    return { value: total, unit: "seconds" };
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && ["hours", "minutes", "seconds"].includes(keys[0]) && typeof v[keys[0]] === "number") {
      return { value: v[keys[0]], unit: keys[0] };
    }
  }
  return null;
}

/** Turns a step into {kind, ...} or {kind: "yaml"} when no form fits. */
function parseAction(step) {
  if (!isPlainObject(step)) return { kind: "yaml", data: step };
  if (hasOnlyKeys(step, ["delay"]) && "delay" in step) {
    const d = parseDelay(step.delay);
    if (d) return { kind: "delay", ...d };
  }
  const verb = "action" in step ? "action" : ("service" in step ? "service" : null);
  if (!verb || ("action" in step && "service" in step) || typeof step[verb] !== "string") return { kind: "yaml", data: step };
  if (!hasOnlyKeys(step, [verb, "target", "data", "entity_id"])) return { kind: "yaml", data: step };
  const idsOk = (v) => typeof v === "string" || (Array.isArray(v) && v.every(x => typeof x === "string"));
  let entities = [];
  let style = "target";
  if (step.target !== undefined) {
    if (!isPlainObject(step.target) || !hasOnlyKeys(step.target, ["entity_id"]) || !idsOk(step.target.entity_id)) return { kind: "yaml", data: step };
    entities = [].concat(step.target.entity_id);
  }
  if (step.entity_id !== undefined) {
    if (step.target !== undefined || !idsOk(step.entity_id)) return { kind: "yaml", data: step };
    entities = [].concat(step.entity_id);
    style = "root";
  }
  const data = step.data === undefined ? {} : step.data;
  if (!isPlainObject(data) || !Object.values(data).every(v => ["string", "number", "boolean"].includes(typeof v))) {
    return { kind: "yaml", data: step };
  }
  const svc = step[verb];
  const [domain, service] = svc.split(".");
  const one = entities.length === 1 ? entities[0] : null;
  const base = { verb, style, svc, entities, data };
  if (svc === "climate.set_temperature" && one && hasOnlyKeys(data, ["temperature", "hvac_mode"]) && "temperature" in data) {
    return { ...base, kind: "climate", entity: one };
  }
  if (["turn_on", "turn_off", "toggle"].includes(service) && one && SWITCH_DOMAINS.includes(domain) &&
      one.split(".")[0] === domain && !Object.keys(data).length) {
    return { ...base, kind: "switch", entity: one, mode: service };
  }
  if (["input_select.select_option", "select.select_option"].includes(svc) && one && one.split(".")[0] === domain &&
      hasOnlyKeys(data, ["option"]) && typeof data.option === "string") {
    return { ...base, kind: "option", entity: one, option: data.option };
  }
  if (domain === "notify" && !entities.length && hasOnlyKeys(data, ["message", "title"]) && "message" in data &&
      Object.values(data).every(v => typeof v === "string")) {
    return { ...base, kind: "notify", target: service, message: data.message, title: data.title || "" };
  }
  if ((svc === "scene.turn_on" || svc === "script.turn_on") && one && one.split(".")[0] === domain && !Object.keys(data).length) {
    return { ...base, kind: "scene", entity: one };
  }
  if (entities.length <= 1) return { ...base, kind: "service", entity: one || "" };
  return { kind: "yaml", data: step };
}

function buildServiceStep(m, svc, entity, data) {
  const step = { [m.verb || "action"]: svc };
  if (entity) {
    if (m.style === "root") step.entity_id = entity;
    else step.target = { entity_id: entity };
  }
  if (data && Object.keys(data).length) step.data = data;
  return step;
}

const DELAY_UNITS = [["seconds", "secondes"], ["minutes", "minutes"], ["hours", "heures"]];

function actionFactory(ctx) {
  return (data, list) => {
    const m = data ? parseAction(data) : (ctx.newAction ? { kind: ctx.newAction, verb: "action", style: "target", data: {}, entities: [] } : { kind: "yaml", data: null });
    switch (m.kind) {
      case "climate": return climateCard(list, ctx, m);
      case "switch": return switchCard(list, ctx, m);
      case "option": return optionCard(list, ctx, m);
      case "delay": return delayCard(list, ctx, m);
      case "notify": return notifyCard(list, ctx, m);
      case "scene": return sceneCard(list, ctx, m);
      case "service": return serviceCard(list, ctx, m);
      default: return yamlCard(list, ctx, m.data, { iconName: "mdi:code-braces", title: "Action en YAML" });
    }
  };
}

function actionCardBase(list, card, { iconName, title, body, read, error, summary }) {
  list.shell(card, { iconName, title, summary: "", body });
  card.read = read;
  card.error = error;
  card.refresh = () => card.setSummary(summary());
  card.update = () => { card.setSummary(summary()); list.onChange(); };
  card.refresh();
  return card;
}

function climateCard(list, ctx, m) {
  const card = {};
  const hass = ctx.hass;
  const temp = el("input", { type: "text", inputmode: "decimal", style: "width:110px", value: m.data?.temperature ?? "" });
  const mode = el("select");
  const unit = el("span", { class: "hint" });
  const picker = entityPicker(hass, { value: m.entity || "", domains: ["climate"], onChange: () => { fillModes(); card.update(); } });
  function fillModes() {
    const st = ctx.states()[picker.value];
    const keep = mode.value || m.data?.hvac_mode || "";
    mode.innerHTML = "";
    mode.append(el("option", { value: "", text: "Mode inchangé" }));
    for (const v of (st && st.attributes && st.attributes.hvac_modes) || []) mode.append(el("option", { value: v, text: v }));
    if (keep && ![...mode.options].some(o => o.value === keep)) mode.append(el("option", { value: keep, text: keep }));
    mode.value = keep;
    unit.textContent = (hass.config && hass.config.unit_system && hass.config.unit_system.temperature) || "°C";
  }
  const read = () => {
    const data = {};
    const t = temp.value.trim();
    data.temperature = /^-?\d+([.,]\d+)?$/.test(t) ? Number(t.replace(",", ".")) : t;
    if (mode.value) data.hvac_mode = mode.value;
    return buildServiceStep(m, "climate.set_temperature", picker.value, data);
  };
  [temp, mode].forEach(x => x.addEventListener("input", () => card.update()));
  mode.addEventListener("change", () => card.update());
  fillModes();
  return actionCardBase(list, card, {
    iconName: "mdi:thermostat", title: "Régler un thermostat",
    body: [
      el("div", {}, el("span", { class: "lbl", text: "Thermostat" }), picker.root),
      el("div", { class: "row" }, el("div", {}, el("span", { class: "lbl", text: "Température" }), el("div", { class: "row" }, temp, unit)),
        el("div", {}, el("span", { class: "lbl", text: "Mode" }), mode)),
      el("div", { class: "hint", text: "Un modèle est accepté, par exemple {{ states('input_number.confort') }}." }),
    ],
    read, summary: () => `${friendly(hass, picker.value) || "(thermostat)"} · ${temp.value || "?"} ${unit.textContent}${mode.value ? " · " + mode.value : ""}`,
    error: () => (!picker.value ? "choisissez un thermostat" : (temp.value.trim() ? null : "indiquez une température")),
  });
}

function switchCard(list, ctx, m) {
  const card = {};
  const hass = ctx.hass;
  let mode = m.mode || "turn_on";
  const picker = entityPicker(hass, { value: m.entity || "", domains: SWITCH_DOMAINS, onChange: () => card.update() });
  const seg = segmented([["turn_on", "Allumer"], ["turn_off", "Éteindre"], ["toggle", "Basculer"]], mode, (v) => { mode = v; card.update(); });
  const label = { turn_on: "allumer", turn_off: "éteindre", toggle: "basculer" };
  return actionCardBase(list, card, {
    iconName: "mdi:toggle-switch-outline", title: "Allumer / éteindre",
    body: [el("div", {}, el("span", { class: "lbl", text: "Entité" }), picker.root), seg],
    read: () => {
      const domain = (picker.value || "homeassistant.x").split(".")[0];
      return buildServiceStep(m, `${domain}.${mode}`, picker.value, {});
    },
    summary: () => `${friendly(hass, picker.value) || "(entité)"} · ${label[mode]}`,
    error: () => (picker.value ? null : "choisissez une entité"),
  });
}

function optionCard(list, ctx, m) {
  const card = {};
  const hass = ctx.hass;
  const opt = el("select");
  const picker = entityPicker(hass, { value: m.entity || "", domains: ["input_select", "select"], onChange: () => { fill(); card.update(); } });
  function fill() {
    const st = ctx.states()[picker.value];
    const keep = opt.value || m.option || "";
    opt.innerHTML = "";
    const options = ((st && st.attributes && st.attributes.options) || []).map(String);
    if (keep && !options.includes(keep)) options.push(keep);
    for (const o of options) opt.append(el("option", { value: o, text: o }));
    opt.value = keep || options[0] || "";
  }
  opt.addEventListener("change", () => card.update());
  fill();
  return actionCardBase(list, card, {
    iconName: "mdi:form-dropdown", title: "Choisir une option",
    body: [el("div", {}, el("span", { class: "lbl", text: "Liste de choix" }), picker.root),
      el("div", {}, el("span", { class: "lbl", text: "Option" }), opt)],
    read: () => buildServiceStep(m, `${(picker.value || "input_select.x").split(".")[0]}.select_option`, picker.value, { option: opt.value }),
    summary: () => `${friendly(hass, picker.value) || "(liste)"} → ${opt.value || "?"}`,
    error: () => (!picker.value ? "choisissez une liste" : (opt.value ? null : "choisissez une option")),
  });
}

function delayCard(list, ctx, m) {
  const card = {};
  const val = el("input", { type: "number", min: "0", step: "1", style: "width:90px", value: m.value ?? 5 });
  const unit = selectEl(DELAY_UNITS, m.unit || "minutes", () => card.update());
  val.addEventListener("input", () => card.update());
  return actionCardBase(list, card, {
    iconName: "mdi:timer-sand", title: "Attendre",
    body: [el("div", { class: "row" }, val, unit),
      el("div", { class: "hint", text: "Les actions suivantes partent après ce délai, même si l'événement s'est terminé entre-temps." })],
    read: () => ({ delay: { [unit.value]: Number(val.value || 0) } }),
    summary: () => `${val.value || 0} ${DELAY_UNITS.find(u => u[0] === unit.value)[1]}`,
    error: () => (Number(val.value) > 0 ? null : "indiquez une durée"),
  });
}

function notifyCard(list, ctx, m) {
  const card = {};
  const hass = ctx.hass;
  const targets = Object.keys((hass.services && hass.services.notify) || {}).filter(s => s !== "send_message").sort();
  if (m.target && !targets.includes(m.target)) targets.push(m.target);
  const nameOf = (s) => ((hass.services.notify || {})[s] || {}).name || s.replace(/^mobile_app_/, "").replace(/_/g, " ");
  const target = selectEl(targets.map(s => [s, nameOf(s)]), m.target || targets[0] || "", () => card.update());
  const title = el("input", { type: "text", class: "full", placeholder: "Titre (facultatif)", value: m.title || "" });
  const msg = el("textarea", { rows: "3" });
  msg.value = m.message || "";
  const preview = templatePreview(hass, () => msg.value, () => ctx.templateVars());
  const insert = el("div", { class: "row" }, el("span", { class: "hint", text: "Insérer" }),
    ...TEMPLATE_VARS.map(([label, tpl]) => el("button", { type: "button", class: "stchip", text: label, onclick: () => insertAtCursor(msg, tpl) })));
  [title, msg].forEach(x => x.addEventListener("input", () => { card.update(); preview.update(); }));
  ctx.onClose(() => preview.close());
  preview.update();
  return actionCardBase(list, card, {
    iconName: "mdi:bell-outline", title: "Envoyer une notification",
    body: [el("div", {}, el("span", { class: "lbl", text: "Destinataire" }), target), title,
      el("div", {}, el("span", { class: "lbl", text: "Message" }), msg), insert, preview.root],
    read: () => {
      const data = { message: msg.value };
      if (title.value.trim()) data.title = title.value;
      return { [m.verb || "action"]: `notify.${target.value}`, data };
    },
    summary: () => `${nameOf(target.value)} · « ${msg.value.slice(0, 50)} »`,
    error: () => (!target.value ? "aucun service de notification" : (msg.value.trim() ? null : "écrivez un message")),
  });
}

function sceneCard(list, ctx, m) {
  const card = {};
  const hass = ctx.hass;
  const picker = entityPicker(hass, { value: m.entity || "", domains: ["scene", "script"], onChange: () => card.update() });
  return actionCardBase(list, card, {
    iconName: "mdi:palette-outline", title: "Activer une scène ou lancer un script",
    body: [el("div", {}, el("span", { class: "lbl", text: "Scène ou script" }), picker.root)],
    read: () => buildServiceStep(m, `${(picker.value || "scene.x").split(".")[0]}.turn_on`, picker.value, {}),
    summary: () => friendly(hass, picker.value) || "(à choisir)",
    error: () => (picker.value ? null : "choisissez une scène ou un script"),
  });
}

function serviceCard(list, ctx, m) {
  const card = {};
  const hass = ctx.hass;
  const all = [];
  for (const [d, svcs] of Object.entries(hass.services || {})) for (const [s, def] of Object.entries(svcs)) all.push({ id: `${d}.${s}`, name: (def && def.name) || s });
  all.sort((a, b) => a.id.localeCompare(b.id));
  const svcInput = el("input", { type: "text", class: "full", placeholder: "domaine.service", value: m.svc || "" });
  const svcList = el("div", { class: "ac-list", style: "display:none" });
  const rows = el("div", { style: "display:flex;flex-direction:column;gap:6px" });
  const picker = entityPicker(hass, { value: m.entity || "", onChange: () => card.update() });
  const values = { ...(m.data || {}) };
  function openList() {
    const f = svcInput.value.trim().toLowerCase();
    svcList.innerHTML = "";
    const shown = all.filter(s => !f || s.id.includes(f) || s.name.toLowerCase().includes(f)).slice(0, 60);
    for (const s of shown) svcList.append(el("div", { class: "ac-item", onmousedown: (e) => { e.preventDefault(); svcInput.value = s.id; svcList.style.display = "none"; renderFields(); card.update(); } },
      el("span", { text: s.name }), el("small", { text: s.id })));
    svcList.style.display = shown.length ? "block" : "none";
  }
  svcInput.addEventListener("focus", openList);
  svcInput.addEventListener("input", openList);
  svcInput.addEventListener("blur", () => setTimeout(() => { svcList.style.display = "none"; renderFields(); card.update(); }, 150));
  function renderFields() {
    const [d, s] = svcInput.value.trim().split(".");
    const fields = ((hass.services[d] || {})[s] || {}).fields || {};
    rows.innerHTML = "";
    const keys = [...new Set([...Object.keys(fields).filter(k => !fields[k].fields), ...Object.keys(values)])];
    for (const k of keys) {
      const def = fields[k] || {};
      const input = el("input", { type: "text", class: "full", placeholder: def.example !== undefined ? String(def.example) : "", value: values[k] ?? "" });
      input.addEventListener("input", () => { if (input.value === "") delete values[k]; else values[k] = input.value; card.update(); });
      rows.append(el("div", {}, el("span", { class: "lbl", text: def.name ? `${def.name} (${k})` : k }), input));
    }
    if (!keys.length) rows.append(el("span", { class: "hint", text: "Ce service n'a pas de paramètre." }));
  }
  renderFields();
  const typed = (v) => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : (v === "true" ? true : (v === "false" ? false : v)));
  return actionCardBase(list, card, {
    iconName: "mdi:cog-outline", title: "Autre service",
    body: [el("div", { class: "ac" }, el("span", { class: "lbl", text: "Service" }), svcInput, svcList),
      el("div", {}, el("span", { class: "lbl", text: "Entité cible (facultative)" }), picker.root),
      el("div", {}, el("span", { class: "lbl", text: "Paramètres" }), rows)],
    read: () => {
      const data = {};
      for (const [k, v] of Object.entries(values)) if (v !== "" && v !== undefined) data[k] = typed(v);
      return buildServiceStep(m, svcInput.value.trim(), picker.value, data);
    },
    summary: () => `${svcInput.value || "(service)"}${picker.value ? " → " + friendly(hass, picker.value) : ""}`,
    error: () => (/^[a-z0-9_]+\.[a-z0-9_]+$/.test(svcInput.value.trim()) ? null : "choisissez un service"),
  });
}

const ACTION_TYPES = [
  ["climate", "Régler un thermostat", "mdi:thermostat"],
  ["switch", "Allumer / éteindre", "mdi:toggle-switch-outline"],
  ["option", "Choisir une option", "mdi:form-dropdown"],
  ["delay", "Attendre", "mdi:timer-sand"],
  ["notify", "Envoyer une notification", "mdi:bell-outline"],
  ["scene", "Activer une scène ou lancer un script", "mdi:palette-outline"],
  ["if", "Si… alors… sinon", "mdi:source-branch"],
  ["service", "Autre service", "mdi:cog-outline"],
  "-",
  ["yaml", "Écrire en YAML", "mdi:code-braces"],
];

// The "Si… alors… sinon" type starts as a YAML template.
const IF_TEMPLATE = {
  if: [{ condition: "state", entity_id: "input_boolean.exemple", state: "on" }],
  then: [{ action: "notify.notify", data: { message: "{{ event.summary }}" } }],
  else: [],
};

// ---------------------------------------------------------------------------
// Event editor
// ---------------------------------------------------------------------------

function splitPhase(phase) {
  let conds = phaseConditions(phase);
  let op = "all";
  if (conds.length === 1 && isPlainObject(conds[0]) && conds[0].condition === "or" &&
      hasOnlyKeys(conds[0], ["condition", "conditions"]) && Array.isArray(conds[0].conditions)) {
    op = "any";
    conds = conds[0].conditions;
  }
  return { conds, op, actions: phaseSteps(phase) };
}

class PhaseSection {
  constructor(editor, key, data) {
    this.editor = editor;
    this.key = key;
    const { conds, op, actions } = splitPhase(data);
    this.op = op;
    const ctx = editor.ctx;
    // Cards report changes while they are being built: the header comes later.
    const onChange = () => { if (this.sum) this.updateSummary(); editor.changed(); };
    this.conds = new CardList({ factory: conditionFactory(ctx), onChange, toast: editor.panel.toast.bind(editor.panel), noun: "Condition" });
    this.acts = new CardList({ factory: actionFactory(ctx), onChange, toast: editor.panel.toast.bind(editor.panel), noun: "Action" });
    this.acts.onFold = () => this.foldLink && this.updateFoldLink();
    for (const c of conds) this.conds.add(c);
    for (const a of actions) this.acts.add(a);

    const isStart = key === "on_start";
    this.badge = el("span", { class: "badge" });
    this.sum = el("span", { class: "sum" });
    const hd = el("div", { class: "hd", role: "button", tabindex: "0" },
      icon(isStart ? "mdi:play-circle-outline" : "mdi:stop-circle-outline"),
      el("span", { class: "name", text: isStart ? "Au démarrage" : "À la fin" }), this.sum,
      el("span", { style: "flex:1" }), this.badge, el("span", { class: "sepv" }), icon("mdi:chevron-down", "chev"));
    const opSel = selectEl([["all", "toutes"], ["any", "au moins une"]], op, (v) => { this.op = v; onChange(); });
    const addCond = el("button", { type: "button", class: "addbtn", style: "margin-top:0;margin-left:auto" }, icon("mdi:plus"), "Ajouter une condition");
    addCond.addEventListener("click", () => popMenu(editor.shadow, addCond, [
      { label: "État d'une entité", icon: "mdi:list-status", action: () => this.addCondition("state") },
      { label: "Valeur numérique", icon: "mdi:gauge", action: () => this.addCondition("numeric") },
      "-",
      { label: "Écrire en YAML", icon: "mdi:code-braces", action: () => this.addCondition("yaml") },
    ]));
    this.foldLink = el("button", { type: "button", class: "link", style: "margin-left:auto" });
    this.foldLink.addEventListener("click", () => { this.acts.setAll(!this.acts.allOpen()); this.updateFoldLink(); });
    const addAct = el("button", { type: "button", class: "addbtn" }, icon("mdi:plus"), "Ajouter une action");
    addAct.addEventListener("click", () => popMenu(editor.shadow, addAct, ACTION_TYPES.map(t => t === "-" ? "-" :
      { label: t[1], icon: t[2], action: () => this.addAction(t[0]) })));
    const bd = el("div", { class: "bd" },
      el("div", { class: "subhead" }, el("span", { class: "t", text: "Conditions" }),
        el("span", { class: "hint", text: "Si" }), opSel, el("span", { class: "hint", text: "de ces conditions sont remplies" }), addCond),
      this.conds.root,
      el("div", { class: "subhead", style: "margin-top:16px" }, el("span", { class: "t", text: "Actions" }),
        el("span", { class: "hint", text: "· exécutées dans l'ordre" }), this.foldLink),
      this.acts.root, addAct);
    this.root = el("div", { class: "phase" }, hd, bd);
    const toggle = () => this.root.classList.toggle("open");
    hd.addEventListener("click", toggle);
    hd.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === hd) { e.preventDefault(); toggle(); } });
    if (conds.length || actions.length || editor.isNew) this.root.classList.add("open");
    this.updateSummary();
    this.updateFoldLink();
  }
  addCondition(kind) {
    this.editor.ctx.newKind = kind === "numeric" ? "numeric" : (kind === "yaml" ? "yaml" : "state");
    const data = kind === "yaml" ? null : undefined;
    const card = kind === "yaml"
      ? this.conds.add({ condition: "template", value_template: "{{ true }}" }, { open: true })
      : this.conds.add(data, { open: true });
    this.editor.ctx.newKind = null;
    this.root.classList.add("open");
    this.editor.changed();
    return card;
  }
  addAction(kind) {
    if (kind === "yaml") this.acts.add(null, { open: true });
    else if (kind === "if") this.acts.add(deepCopy(IF_TEMPLATE), { open: true });
    else { this.editor.ctx.newAction = kind; this.acts.add(null, { open: true }); this.editor.ctx.newAction = null; }
    this.updateFoldLink();
    this.editor.changed();
  }
  updateFoldLink() { this.foldLink.textContent = this.acts.allOpen() ? "Tout replier" : "Tout développer"; this.foldLink.style.display = this.acts.cards.length ? "" : "none"; }
  conditions() {
    const items = this.conds.read();
    return this.op === "any" && items.length > 1 ? [{ condition: "or", conditions: items }] : items;
  }
  read() {
    const conditions = this.conditions();
    const actions = this.acts.read();
    if (!actions.length && !conditions.length) return null;
    if (!conditions.length) return actions;
    return { conditions, actions };
  }
  errors() { return [...this.conds.errors(), ...this.acts.errors()]; }
  async flush() { for (const c of [...this.conds.cards, ...this.acts.cards]) if (c.flush) await c.flush(); }
  refresh() { this.conds.refresh(); this.updateSummary(); }
  updateSummary() {
    const nc = this.conds.cards.length, na = this.acts.cards.length;
    const parts = [];
    if (nc) parts.push(`${nc} condition${nc > 1 ? "s" : ""}`);
    parts.push(na ? `${na} action${na > 1 ? "s" : ""}` : "aucune action");
    this.sum.textContent = `· ${parts.join(" · ")}`;
    const conds = this.conds.read();
    if (!conds.length) { this.badge.className = "badge"; this.badge.textContent = ""; return; }
    if (this.conds.errors().length) { this.badge.className = "badge warn"; this.badge.textContent = "Règle incomplète"; return; }
    const states = this.editor.ctx.states();
    const res = conds.map(c => evalCondition(c, states));
    const met = this.op === "any" ? res.some(Boolean) : res.every(Boolean);
    this.badge.className = `badge ${met ? "ok" : "ko"}`;
    this.badge.textContent = met ? "Règle remplie" : "Règle non remplie";
  }
}

class EventEditor {
  /**
   * opts: {entryId, occ}  to edit an occurrence (or a non-recurring event),
   *       {entryId, start, end, allDay} to create one,
   *       {entryId, copy: data} to create a copy.
   */
  constructor(panel, opts) {
    this.panel = panel;
    this.shadow = panel.shadowRoot;
    this.hass = panel._hass;
    this.opts = opts;
    this.entryId = opts.entryId;
    this.occ = opts.occ || null;
    this.isNew = !this.occ;
    this.recurring = !!(this.occ && this.occ.rrule);
    this.scope = this.recurring ? "all" : "all";
    this.series = null;
    this.dirty = false;
    this.ready = false;
    this.closers = [];
    this.ctx = {
      hass: this.hass,
      ws: (m) => panel.ws(m),
      states: () => (panel._hass && panel._hass.states) || {},
      templateVars: () => this.templateVars(),
      onClose: (fn) => this.closers.push(fn),
    };
  }

  async open() {
    let data;
    if (this.opts.copy) data = deepCopy(this.opts.copy);
    else if (this.occ) {
      if (this.recurring) {
        try { this.series = await this.panel.ws({ type: "local_agenda/event/get", entry_id: this.entryId, uid: this.occ.uid }); }
        catch (e) { this.series = null; }
      }
      data = this.dataFor(this.scope);
    } else {
      data = { summary: "", start: this.opts.start, end: this.opts.end, all_day: !!this.opts.allDay, rrule: null,
        note: "", location: "", color: null, icon: null, actions: {} };
    }
    this.data = data;
    this.render();
    this.ready = true;
  }

  dataFor(scope) {
    const src = scope === "all" && this.series ? this.series : this.occ;
    return {
      summary: src.summary, start: src.start, end: src.end, all_day: src.all_day,
      rrule: (this.series && this.series.rrule) || this.occ.rrule || null,
      note: src.note || "", location: src.location || "", color: src.color || null, icon: src.icon || null,
      actions: deepCopy(src.actions || {}),
    };
  }

  changed() { if (this.ready) this.dirty = true; }

  templateVars() {
    const cal = this.panel.cal(this.agendaSel ? this.agendaSel.value : this.entryId);
    const w = this.readWhen();
    return {
      agenda: cal ? cal.name : "", phase: "start",
      event: { summary: this.titleIn ? this.titleIn.value : "", start: w.start, end: w.end, uid: this.occ ? this.occ.uid : "",
        description: this.noteIn ? this.noteIn.value : "", location: this.data.location || "", all_day: w.all_day },
    };
  }

  // ---------- rendering ----------
  render() {
    const d = this.data;
    const cal = this.panel.cal(this.entryId);
    this.errBox = el("div", { class: "err-box", style: "display:none" });
    this.titleIn = el("input", { type: "text", class: "full", placeholder: "Matin, Soir, Week-end…", value: d.summary || "" });
    this.titleIn.addEventListener("input", () => this.changed());

    // Color
    this.color = d.color;
    const colors = el("div", { class: "colors" });
    const paintColors = () => {
      colors.innerHTML = "";
      const ac = agendaColor(this.panel.cal(this.agendaSel ? this.agendaSel.value : this.entryId), this.panel.calIndex(this.entryId));
      colors.append(el("button", { type: "button", class: `btn ${!this.color ? "primary" : ""}`, style: "padding:2px 9px 2px 3px",
        onclick: () => { this.color = null; paintColors(); this.changed(); } },
        el("span", { class: "dot", style: `width:16px;height:16px;background:${ac}` }), "Couleur de l'agenda"));
      for (const [name, label] of EVENT_COLORS) {
        colors.append(el("button", { type: "button", class: `sw ${this.color === name ? "on" : ""}`, title: label, "aria-label": label,
          style: `background:${name}`, onclick: () => { this.color = name; paintColors(); this.changed(); } }));
      }
      if (this.color && !EVENT_COLORS.some(c => c[0] === this.color)) {
        colors.append(el("button", { type: "button", class: "sw on", title: this.color, style: `background:${this.color}` }));
      }
    };
    // Icon
    this.icon = d.icon;
    const icons = el("div", { class: "colors" });
    const paintIcons = () => {
      icons.innerHTML = "";
      icons.append(el("button", { type: "button", class: `btn ${!this.icon ? "primary" : ""}`, text: "Aucune", onclick: () => { this.icon = null; paintIcons(); this.changed(); } }));
      for (const name of EVENT_ICONS) {
        icons.append(el("button", { type: "button", class: `iconbtn`, title: name,
          style: this.icon === name ? "outline:2px solid var(--la-text);color:var(--la-text)" : "",
          onclick: () => { this.icon = name; paintIcons(); this.changed(); } }, icon(name)));
      }
    };

    // Agenda
    this.agendaSel = selectEl(this.panel._cals.map(c => [c.entry_id, c.name]), this.entryId, () => { paintColors(); this.changed(); });
    paintColors();
    paintIcons();

    this.whenBox = el("div");
    this.repeatBox = el("div");
    this.renderWhen();

    this.phases = [new PhaseSection(this, "on_start", d.actions.on_start), new PhaseSection(this, "on_stop", d.actions.on_stop)];
    this.noteIn = el("textarea", { rows: "2", placeholder: "Texte libre, conservé au-dessus du bloc d'actions" });
    this.noteIn.value = d.note || "";
    this.noteIn.addEventListener("input", () => this.changed());

    const head = el("div", { class: "dlg-head" },
      el("span", { class: "ttl", text: this.isNew ? "Nouvel événement" : "Modifier l'événement" }),
      el("span", { class: "pill" }, el("span", { class: "dot", style: `background:${agendaColor(cal, this.panel.calIndex(this.entryId))}` }), cal ? cal.name : ""),
      el("button", { type: "button", class: "iconbtn", "aria-label": "Fermer", onclick: () => this.close() }, icon("mdi:close")));

    let scopeBar = null;
    if (this.recurring) {
      scopeBar = el("div", { class: "scope" },
        el("span", { text: `Occurrence du ${fmtDay(wm(this.occ.start), true)}` }),
        el("span", { style: "flex:1" }),
        segmented([["this", "Celle-ci"], ["future", "Et les suivantes"], ["all", "Toute la série"]], this.scope, (v) => this.setScope(v)));
    }

    const foot = el("div", { class: "dlg-foot" },
      this.isNew ? null : el("button", { type: "button", class: "btn danger", onclick: () => this.remove() }, icon("mdi:delete-outline"), "Supprimer"),
      this.isNew ? null : el("button", { type: "button", class: "btn ghost", onclick: () => this.duplicate() }, icon("mdi:content-copy"), "Dupliquer"),
      el("span", { style: "flex:1" }),
      el("button", { type: "button", class: "btn", text: "Annuler", onclick: () => this.close() }),
      this.saveBtn = el("button", { type: "button", class: "btn primary", text: "Enregistrer", onclick: () => this.save() }));

    this.dialog = el("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
      head, scopeBar, this.errBox,
      el("div", { class: "dlg-sec" }, el("span", { class: "lbl", text: "Titre" }), this.titleIn),
      el("div", { class: "dlg-sec" }, el("span", { class: "lbl", text: "Couleur" }), colors),
      el("div", { class: "dlg-sec" }, el("span", { class: "lbl", text: "Icône (facultative)" }), icons),
      el("div", { class: "dlg-sec" }, el("span", { class: "lbl", text: "Agenda" }), this.agendaSel),
      this.whenBox, this.repeatBox,
      ...this.phases.map(p => p.root),
      el("div", { class: "dlg-sec" }, el("span", { class: "lbl", text: "Note" }), this.noteIn),
      foot);
    this.overlay = el("div", { class: "overlay" }, this.dialog);
    this.overlay.addEventListener("pointerdown", (e) => { if (e.target === this.overlay) this.close(); });
    // Escape closes the editor, unless a small dialog is open on top of it.
    this.keyHandler = (e) => { if (e.key === "Escape" && !this.shadow.querySelector(".dialog.small")) this.close(); };
    window.addEventListener("keydown", this.keyHandler);
    this.shadow.append(this.overlay);
    this.agendaSel.disabled = !this.isNew && this.scope !== "all";
  }

  renderWhen() {
    const d = this.data;
    const allDay = !!d.all_day;
    const s = wm(d.start), e = wm(d.end);
    const endShown = allDay ? e - DAY : e;
    this.allDayIn = el("input", { type: "checkbox" });
    this.allDayIn.checked = allDay;
    this.sDate = el("input", { type: "date", value: wDate(s) });
    this.sTime = el("input", { type: "time", step: "300", value: wTime(s) });
    this.eDate = el("input", { type: "date", value: wDate(endShown) });
    this.eTime = el("input", { type: "time", step: "300", value: wTime(e) });
    const timeRow = (date, time, label) => el("div", {}, el("span", { class: "lbl", text: label }),
      el("div", { class: "row", style: "flex-wrap:nowrap" }, date, allDay ? null : time));
    this.allDayIn.addEventListener("change", () => {
      this.data = { ...this.data, ...this.readWhen(), all_day: this.allDayIn.checked };
      if (this.allDayIn.checked) {
        this.data.start = this.data.start.slice(0, 10);
        this.data.end = wDate(Math.max(wm(this.data.end.slice(0, 10)), wm(this.data.start)) + DAY);
      } else {
        this.data.start = `${this.data.start.slice(0, 10)}T08:00`;
        this.data.end = `${this.data.start.slice(0, 10)}T09:00`;
      }
      this.changed();
      this.renderWhen();
    });
    // Keep the duration when the start moves.
    const shift = () => {
      const before = this.readWhen();
      const dur = wm(this.lastWhen.end) - wm(this.lastWhen.start);
      const ns = wm(before.start);
      const ne = ns + Math.max(dur, allDay ? DAY : 15);
      this.eDate.value = wDate(allDay ? ne - DAY : ne);
      if (!allDay) this.eTime.value = wTime(ne);
      this.lastWhen = this.readWhen();
      this.changed();
      this.renderRepeat();
    };
    this.sDate.addEventListener("change", shift);
    this.sTime.addEventListener("change", shift);
    [this.eDate, this.eTime].forEach(x => x.addEventListener("change", () => { this.lastWhen = this.readWhen(); this.changed(); }));
    this.whenBox.replaceChildren(el("div", { class: "dlg-sec" },
      el("label", { class: "row", style: "margin-bottom:8px" }, this.allDayIn, "Toute la journée"),
      el("div", { class: "grid2" }, timeRow(this.sDate, this.sTime, "Début"), timeRow(this.eDate, this.eTime, "Fin"))));
    this.lastWhen = this.readWhen();
    this.renderRepeat();
  }

  readWhen() {
    const allDay = this.allDayIn ? this.allDayIn.checked : !!this.data.all_day;
    if (!this.sDate) return { start: this.data.start, end: this.data.end, all_day: allDay };
    if (allDay) {
      return { start: this.sDate.value, end: wDate(wm(this.eDate.value || this.sDate.value) + DAY), all_day: true };
    }
    return { start: `${this.sDate.value}T${this.sTime.value || "00:00"}`, end: `${this.eDate.value}T${this.eTime.value || "00:00"}`, all_day: false };
  }

  renderRepeat() {
    if (this.scope === "this") { this.repeatBox.replaceChildren(); return; }
    const start = this.readWhen().start;
    if (!this.rmodel) this.rmodel = parseRrule(this.data.rrule, start);
    const m = this.rmodel;
    const update = () => { this.changed(); this.renderRepeat(); };
    const freq = selectEl([["none", "Jamais"], ["daily", "Chaque jour"], ["weekly", "Chaque semaine"], ["monthly", "Chaque mois"],
      ["yearly", "Chaque année"], ["custom", "Règle personnalisée"]], m.freq, (v) => {
      m.freq = v;
      if (v === "custom" && !m.raw) m.raw = buildRrule({ ...m, freq: "weekly" }, start) || "FREQ=WEEKLY";
      update();
    });
    const parts = [el("div", { class: "row" }, freq)];
    if (["daily", "weekly", "monthly", "yearly"].includes(m.freq)) {
      const unit = { daily: "jour(s)", weekly: "semaine(s)", monthly: "mois", yearly: "an(s)" }[m.freq];
      const iv = el("input", { type: "number", min: "1", step: "1", style: "width:70px", value: m.interval });
      iv.addEventListener("change", () => { m.interval = Math.max(1, Number(iv.value) || 1); update(); });
      parts[0].append(el("span", { class: "hint", text: "tous les" }), iv, el("span", { class: "hint", text: unit }));
      if (m.freq === "weekly") {
        parts.push(el("div", { class: "daychips", style: "margin-top:8px" }, ...DAYS_SHORT.map((label, i) =>
          el("button", { type: "button", class: `dchip ${m.days.includes(i) ? "on" : ""}`, text: label[0].toUpperCase(), title: DAYS_LONG[i],
            onclick: () => { const k = m.days.indexOf(i); if (k < 0) m.days.push(i); else if (m.days.length > 1) m.days.splice(k, 1); update(); } }))));
      }
      if (m.freq === "monthly") {
        const s = wm(start);
        const n = Math.ceil(new Date(s * 60000).getUTCDate() / 7);
        parts.push(el("div", { class: "row", style: "margin-top:8px" }, selectEl([
          ["day", `le ${new Date(s * 60000).getUTCDate()} du mois`],
          ["nth", `le ${n}e ${DAYS_LONG[weekday(s)]}`],
          ["last", `le dernier ${DAYS_LONG[weekday(s)]}`]], m.monthly, (v) => { m.monthly = v; update(); })));
      }
      const until = el("input", { type: "date", value: m.until || wDate(wm(start) + 90 * DAY) });
      const count = el("input", { type: "number", min: "1", style: "width:80px", value: m.count || 10 });
      until.addEventListener("change", () => { m.until = until.value; update(); });
      count.addEventListener("change", () => { m.count = Math.max(1, Number(count.value) || 1); update(); });
      const endSel = selectEl([["never", "sans fin"], ["until", "jusqu'au"], ["count", "nombre de fois"]], m.end, (v) => {
        m.end = v; if (v === "until" && !m.until) m.until = until.value; update();
      });
      parts.push(el("div", { class: "row", style: "margin-top:8px" }, el("span", { class: "hint", text: "Fin :" }), endSel,
        m.end === "until" ? until : null, m.end === "count" ? count : null));
    }
    if (m.freq === "custom") {
      const raw = el("input", { type: "text", class: "full mono", value: m.raw });
      raw.addEventListener("change", () => { m.raw = raw.value; this.changed(); this.renderRepeat(); });
      parts.push(el("div", { style: "margin-top:8px" }, raw, el("div", { class: "hint", text: "Règle iCalendar (RFC 5545), par exemple FREQ=WEEKLY;BYDAY=MO,WE" })));
    }
    const rule = buildRrule(m, start, this.readWhen().all_day);
    parts.push(el("div", { class: "row", style: "margin-top:6px" },
      el("span", { class: "hint", text: describeRrule(rule, start) }), el("span", { style: "flex:1" }),
      rule ? el("span", { class: "mono", text: rule }) : null));
    this.repeatBox.replaceChildren(el("div", { class: "dlg-sec" }, el("span", { class: "lbl", text: "Répétition" }), ...parts));
  }

  setScope(scope) {
    const before = { title: this.titleIn.value, note: this.noteIn.value };
    this.scope = scope;
    const fresh = this.dataFor(scope);
    this.data = { ...this.data, start: fresh.start, end: fresh.end, all_day: fresh.all_day, rrule: fresh.rrule };
    this.rmodel = null;
    this.renderWhen();
    this.titleIn.value = before.title;
    this.noteIn.value = before.note;
    this.agendaSel.disabled = scope !== "all";
    if (scope !== "all") this.agendaSel.value = this.entryId;
  }

  // ---------- actions ----------
  showError(msg) {
    this.errBox.textContent = msg;
    this.errBox.style.display = msg ? "" : "none";
    if (msg) this.errBox.scrollIntoView({ block: "nearest" });
  }

  async save() {
    for (const p of this.phases) await p.flush();
    const w = this.readWhen();
    const errors = [];
    if (!w.start || !w.end || w.start.length < 10) errors.push("Indiquez la date de début et de fin.");
    else if (wm(w.end) <= wm(w.start)) errors.push("La fin doit être après le début.");
    for (const p of this.phases) {
      const label = p.key === "on_start" ? "Au démarrage" : "À la fin";
      for (const e of p.errors()) errors.push(`${label} — ${e}.`);
    }
    if (errors.length) { this.showError(errors.join("\n")); return; }
    const actions = {};
    for (const p of this.phases) { const v = p.read(); if (v) actions[p.key] = v; }
    const rrule = this.scope === "this" ? null : buildRrule(this.rmodel || parseRrule(this.data.rrule, w.start), w.start, w.all_day);
    const event = {
      summary: this.titleIn.value.trim(), start: w.start, end: w.end, all_day: w.all_day,
      note: this.noteIn.value.trim(), location: this.data.location || "",
      color: this.color || null, icon: this.icon || null, actions,
    };
    if (this.scope !== "this") event.rrule = rrule;
    const msg = { type: "local_agenda/event/save", entry_id: this.entryId, event };
    if (!this.isNew) {
      msg.uid = this.occ.uid;
      msg.scope = this.recurring ? this.scope : "all";
      if (this.recurring && this.scope !== "all") msg.recurrence_id = this.occ.recurrence_id;
    }
    if (this.agendaSel.value !== this.entryId) msg.target_entry_id = this.agendaSel.value;
    this.saveBtn.disabled = true;
    try {
      await this.panel.ws(msg);
      this.dirty = false;
      this.close(true);
      this.panel.toast(this.isNew ? "Événement créé" : "Événement enregistré");
      this.panel.reload();
    } catch (e) {
      this.showError(`Enregistrement refusé : ${e.message || e}`);
    } finally {
      this.saveBtn.disabled = false;
    }
  }

  async remove() {
    let scope = "all";
    if (this.recurring) {
      scope = await this.panel.choose(`Supprimer « ${this.occ.summary || "sans titre"} »`, [
        ["this", "Cette occurrence"], ["future", "Celle-ci et les suivantes"], ["all", "Toute la série"]]);
      if (!scope) return;
    } else if (!(await this.panel.confirm(`Supprimer « ${this.occ.summary || "sans titre"} » ?`))) return;
    try {
      await this.panel.ws({ type: "local_agenda/event/delete", entry_id: this.entryId, uid: this.occ.uid,
        recurrence_id: scope === "all" ? null : this.occ.recurrence_id, scope });
      this.dirty = false;
      this.close(true);
      this.panel.toast("Événement supprimé");
      this.panel.reload();
    } catch (e) {
      this.showError(`Suppression refusée : ${e.message || e}`);
    }
  }

  duplicate() {
    const w = this.readWhen();
    const copy = {
      summary: `${this.titleIn.value} (copie)`, start: w.start, end: w.end, all_day: w.all_day,
      rrule: this.scope === "this" ? null : buildRrule(this.rmodel || parseRrule(this.data.rrule, w.start), w.start, w.all_day),
      note: this.noteIn.value, location: this.data.location || "", color: this.color, icon: this.icon,
      actions: Object.fromEntries(this.phases.map(p => [p.key, p.read()]).filter(([, v]) => v)),
    };
    const entryId = this.agendaSel.value;
    this.dirty = false;
    this.close(true);
    this.panel.openEditor({ entryId, copy });
  }

  async close(force = false) {
    if (!force && this.dirty && !(await this.panel.confirm("Abandonner les modifications ?"))) return;
    window.removeEventListener("keydown", this.keyHandler);
    for (const fn of this.closers) { try { fn(); } catch (e) { /* ignore */ } }
    this.overlay.remove();
    this.panel._editor = null;
  }

  refresh() { if (this.phases) this.phases.forEach(p => p.refresh()); }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
const PREFS_KEY = "local-agenda-panel";
const HOUR = 44;            // px per hour in the week view
const SNAP = 15;            // minutes
const OTHER_COLORS = ["#97C459", "#85B7EB", "#ED93B1", "#F0997B", "#AFA9EC", "#5DCAA5"];
const VIEWS = [["week", "Semaine", "mdi:calendar-week"], ["month", "Mois", "mdi:calendar-month"],
  ["house", "Maison", "mdi:home-clock-outline"], ["list", "Liste", "mdi:format-list-bulleted"],
  ["runs", "Exécutions", "mdi:playlist-check"]];

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* private mode */ }
}

// Greedy lanes: each item goes on the first lane free at its start.
function assignLanes(items) {
  const lanes = [];
  for (const it of items.slice().sort((a, b) => a.s - b.s || b.e - a.e)) {
    let lane = lanes.findIndex(end => end <= it.s);
    if (lane < 0) { lane = lanes.length; lanes.push(it.e); } else lanes[lane] = it.e;
    it.lane = lane;
  }
  return lanes.length;
}

// Side-by-side columns for overlapping blocks of one day column.
function layoutColumns(items) {
  const sorted = items.slice().sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const n = assignLanes(cluster);
    cluster.forEach(it => { it.cols = n; });
    cluster = [];
  };
  for (const it of sorted) {
    if (it.s >= clusterEnd && cluster.length) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
}

class LocalAgendaPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._narrow = false;
    this.prefs = loadPrefs();
    this.view = this.prefs.view || "week";
    this._cals = [];
    this._occ = {};
    this._others = {};
    this._status = {};
    this._history = [];
    this._editor = null;
    this._drawer = false;
    this._scrolledFor = null;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) { this.init(); return; }
    if (this._editor) { this._editor.hass = hass; this._editor.ctx.hass = hass; clearTimeout(this._edT); this._edT = setTimeout(() => this._editor && this._editor.refresh(), 800); }
  }
  get hass() { return this._hass; }
  set narrow(n) { const changed = this._narrow !== !!n; this._narrow = !!n; if (changed && this._root) this.renderAll(); }
  set panel(p) { this._panel = p; }

  connectedCallback() {
    if (this._hass && !this._timer) this.startTimer();
  }
  disconnectedCallback() {
    clearInterval(this._timer); this._timer = null;
    (this._unsubs || []).forEach(u => u.then(f => f()).catch(() => {}));
    this._unsubs = [];
  }

  get tz() { return (this._hass && this._hass.config && this._hass.config.time_zone) || undefined; }
  get now() { return nowWall(this.tz); }
  get isNarrow() { return this._narrow || (this.offsetWidth || 1000) < 760; }
  ws(msg) { return this._hass.callWS(msg); }
  cal(id) { return this._cals.find(c => c.entry_id === id); }
  calIndex(id) { return Math.max(0, this._cals.findIndex(c => c.entry_id === id)); }
  calColor(id) { return agendaColor(this.cal(id), this.calIndex(id)); }
  hidden(id) { return (this.prefs.hidden || []).includes(id); }
  otherSelected() { return (this.prefs.others || []).filter(id => this._hass.states[id]); }
  otherColor(id) { const all = this.otherCalendars(); return OTHER_COLORS[Math.max(0, all.indexOf(id)) % OTHER_COLORS.length]; }
  otherCalendars() {
    const ours = new Set(this._cals.map(c => c.entity_id));
    return Object.keys(this._hass.states).filter(id => id.startsWith("calendar.") && !ours.has(id)).sort();
  }
  setPrefs(p) { this.prefs = { ...this.prefs, ...p }; savePrefs(this.prefs); }

  async init() {
    this._anchor = dayOf(this.now);
    const style = el("style");
    style.textContent = STYLES;
    this._root = el("div", { class: "root" });
    this.shadowRoot.replaceChildren(style, this._root);
    this._unsubs = [];
    if (this._hass.connection) {
      const later = () => { clearTimeout(this._reloadT); this._reloadT = setTimeout(() => this.reload(), 300); };
      this._unsubs.push(this._hass.connection.subscribeEvents(later, "local_agenda_updated"));
      this._unsubs.push(this._hass.connection.subscribeEvents(() => { if (this.view === "runs") later(); }, "local_agenda_history"));
    }
    this.startTimer();
    // Switch between the phone and desktop layouts when the width crosses the limit.
    this._wasNarrow = this.isNarrow;
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => {
        if (this.isNarrow !== this._wasNarrow) { this._wasNarrow = this.isNarrow; this.reload(); }
      });
      this._ro.observe(this);
    }
    await this.reload();
  }

  startTimer() {
    clearInterval(this._timer);
    this._timer = setInterval(() => { this.loadStatus().then(() => this.renderAll(true)); }, 60000);
  }

  // ---------- data ----------
  range() {
    const a = this._anchor;
    switch (this.view) {
      case "month": { const ms = monthStart(a); const g = mondayOf(ms); return [g, g + 42 * DAY]; }
      case "house": return [a, a + DAY];
      case "list": { const t = dayOf(this.now); return [t, t + 61 * DAY]; }
      case "runs": { const t = dayOf(this.now); return [t, t + 2 * DAY]; }
      default: return this.isNarrow ? [a, a + DAY] : [mondayOf(a), mondayOf(a) + 7 * DAY];
    }
  }

  async reload() {
    try {
      this._cals = await this.ws({ type: "local_agenda/list_calendars" });
      const [a, b] = this.range();
      const res = await this.ws({ type: "local_agenda/occurrences", start: wDate(a), end: wDate(b) });
      this._occ = res.agendas || {};
      await Promise.all([this.loadOthers(a, b), this.loadStatus(), this.view === "runs" ? this.loadHistory() : null]);
    } catch (e) {
      this.toast(`Chargement impossible : ${e.message || e}`, null, null, "error");
    }
    this.renderAll(true);
  }

  async loadStatus() {
    const t = dayOf(this.now);
    try {
      const res = await this.ws({ type: "local_agenda/occurrences", start: wDate(t - DAY), end: wDate(t + 8 * DAY) });
      this._status = res.agendas || {};
    } catch (e) { /* keep the previous status */ }
  }

  async loadHistory() {
    try { this._history = await this.ws({ type: "local_agenda/history" }); } catch (e) { this._history = []; }
  }

  async loadOthers(a, b) {
    const out = {};
    const iso = (m) => new Date(m * 60000).toISOString(); // a day of margin on each side
    await Promise.all(this.otherSelected().map(async (id) => {
      try {
        const evs = await this._hass.callApi("GET", `calendars/${id}?start=${encodeURIComponent(iso(a - DAY))}&end=${encodeURIComponent(iso(b + DAY))}`);
        out[id] = evs.map(e => {
          const allDay = !!(e.start && e.start.date);
          const s = allDay ? wm(e.start.date) : wallOf(new Date(e.start.dateTime), this.tz);
          const en = allDay ? wm(e.end.date) : wallOf(new Date(e.end.dateTime), this.tz);
          return { summary: e.summary || "", s, e: Math.max(en, s + (allDay ? DAY : 15)), allDay };
        });
      } catch (err) { out[id] = []; }
    }));
    this._others = out;
  }

  // Everything to draw, as {kind, s, e, allDay, summary, evc, agenda, occ, entry}.
  items({ others = true } = {}) {
    const list = [];
    this._cals.forEach((cal, i) => {
      if (this.hidden(cal.entry_id)) return;
      for (const o of this._occ[cal.entry_id] || []) {
        const s = wm(o.start), e = wm(o.end);
        list.push({ kind: "local", entry: cal.entry_id, cal, occ: o, s, e: Math.max(e, s + (o.all_day ? DAY : 15)),
          allDay: o.all_day, summary: o.summary || "(sans titre)", agenda: agendaColor(cal, i), evc: o.color || agendaColor(cal, i) });
      }
    });
    if (others) {
      for (const id of this.otherSelected()) {
        for (const o of this._others[id] || []) {
          const c = this.otherColor(id);
          list.push({ kind: "other", entry: id, s: o.s, e: o.e, allDay: o.allDay, summary: o.summary, agenda: c, evc: c });
        }
      }
    }
    return list;
  }

  // On-start conditions not met right now: the block is drawn crossed out.
  conditionsKo(item) {
    if (item.kind !== "local") return false;
    return phaseConditionsMet((item.occ.actions || {}).on_start, this._hass.states) === false;
  }

  // ---------- shell ----------
  renderAll(keepScroll = false) {
    if (!this._root) return;
    const scroll = this._root.querySelector(".scroll");
    const top = keepScroll && scroll ? scroll.scrollTop : null;
    const narrow = this.isNarrow;
    this._root.replaceChildren(...[this.renderToolbar(narrow), narrow ? this.renderPills() : null,
      el("div", { class: "body" }, (!narrow || this._drawer) ? this.renderSide(narrow) : null, this.renderMain())].filter(Boolean));
    const sc = this._root.querySelector(".scroll");
    if (sc && top !== null && this._scrolledFor === this.view) sc.scrollTop = top;
    else if (sc && this.view === "week") { sc.scrollTop = 6 * HOUR; }
    this._scrolledFor = this.view;
  }

  title() {
    const a = this._anchor;
    switch (this.view) {
      case "month": return fmtMonth(monthStart(a));
      case "house": return fmtDay(a, true);
      case "list": return "Événements à venir";
      case "runs": return "Exécutions";
      default: { const [s, e] = this.range(); return e - s === DAY ? fmtDay(s, true) : fmtRange(s, e - DAY); }
    }
  }

  step(dir) {
    if (dir === 0) this._anchor = dayOf(this.now);
    else if (this.view === "month") this._anchor = addMonths(monthStart(this._anchor), dir);
    else if (this.view === "house" || this.isNarrow) this._anchor += dir * DAY;
    else this._anchor += dir * 7 * DAY;
    this._scrolledFor = null;
    this.reload();
  }

  setView(v) {
    this.view = v;
    this.setPrefs({ view: v });
    this._scrolledFor = null;
    this.reload();
  }

  renderToolbar(narrow) {
    const nav = !["list", "runs"].includes(this.view);
    return el("div", { class: "toolbar" },
      narrow ? el("button", { type: "button", class: "iconbtn", "aria-label": "Agendas", onclick: () => { this._drawer = !this._drawer; this.renderAll(true); } }, icon("mdi:menu")) : null,
      nav ? el("button", { type: "button", class: "iconbtn", "aria-label": "Précédent", onclick: () => this.step(-1) }, icon("mdi:chevron-left")) : null,
      nav ? el("button", { type: "button", class: "btn", text: "Aujourd'hui", onclick: () => this.step(0) }) : null,
      nav ? el("button", { type: "button", class: "iconbtn", "aria-label": "Suivant", onclick: () => this.step(1) }, icon("mdi:chevron-right")) : null,
      el("span", { class: "title", text: this.title() }),
      segmented(VIEWS.map(([v, label, ic]) => [v, narrow ? "" : (v === "week" && narrow ? "Jour" : label), ic]), this.view, (v) => this.setView(v)));
  }

  renderPills() {
    return el("div", { class: "pills" }, ...this._cals.map((c, i) => el("button", {
      type: "button", class: `pill ${this.hidden(c.entry_id) ? "off" : ""}`, onclick: () => this.toggleHidden(c.entry_id),
    }, el("span", { class: "dot", style: `background:${agendaColor(c, i)}` }), c.name)));
  }

  toggleHidden(id) {
    const h = new Set(this.prefs.hidden || []);
    if (h.has(id)) h.delete(id); else h.add(id);
    this.setPrefs({ hidden: [...h] });
    this.renderAll(true);
  }

  statusOf(cal) {
    if (cal.suspended) return "Suspendu";
    const now = this.now;
    const occ = (this._status[cal.entry_id] || []).map(o => ({ o, s: wm(o.start), e: wm(o.end) }));
    const cur = occ.filter(x => x.s <= now && now < x.e).sort((a, b) => b.s - a.s)[0];
    if (cur) return `En cours : ${cur.o.summary || "sans titre"} · fin à ${wTime(cur.e)}`;
    const next = occ.filter(x => x.s > now).sort((a, b) => a.s - b.s)[0];
    if (!next) return "Aucun événement cette semaine";
    const dd = (dayOf(next.s) - dayOf(now)) / DAY;
    const when = dd === 0 ? "aujourd'hui" : (dd === 1 ? "demain" : fmtDay(next.s));
    return `Prochain : ${next.o.summary || "sans titre"} · ${when} ${next.o.all_day ? "" : wTime(next.s)}`.trim();
  }

  renderSide(narrow) {
    const side = el("div", { class: `side ${narrow ? "drawer" : ""}` });
    const allVisible = this._cals.every(c => !this.hidden(c.entry_id));
    side.append(el("div", { class: "calrow" },
      el("span", { class: "calbox", style: `border-color:var(--la-text2);${allVisible ? "background:var(--la-text2)" : ""}`,
        onclick: () => { this.setPrefs({ hidden: allVisible ? this._cals.map(c => c.entry_id) : [] }); this.renderAll(true); } },
        allVisible ? icon("mdi:check") : null),
      el("span", { class: "calname", text: "Tous" })));
    this._cals.forEach((c, i) => {
      const color = agendaColor(c, i);
      const vis = !this.hidden(c.entry_id);
      const more = el("button", { type: "button", class: "iconbtn", "aria-label": "Options de l'agenda" }, icon("mdi:dots-vertical"));
      more.addEventListener("click", () => popMenu(this.shadowRoot, more, [
        { label: "Couleur de l'agenda", icon: "mdi:palette-outline", action: () => this.pickAgendaColor(c) },
        { label: "Renommer", icon: "mdi:pencil-outline", action: () => this.renameAgenda(c) },
        { label: c.suspended ? "Reprendre" : "Suspendre", icon: c.suspended ? "mdi:play" : "mdi:pause", action: () => this.setSuspended(c, !c.suspended) },
      ]));
      side.append(el("div", { class: `calrow ${c.suspended ? "off" : ""}` },
        el("span", { class: "calbox", style: `border-color:${color};${vis ? "background:" + color : ""}`, title: vis ? "Masquer" : "Afficher",
          onclick: () => this.toggleHidden(c.entry_id) }, vis ? icon("mdi:check") : null),
        el("div", { style: "min-width:0;flex:1" }, el("div", { class: "calname", text: c.name }), el("div", { class: "calstat", text: this.statusOf(c) })),
        el("button", { type: "button", class: `switch ${c.suspended ? "off" : ""}`, title: c.suspended ? "Reprendre" : "Suspendre",
          "aria-label": c.suspended ? "Reprendre" : "Suspendre", onclick: () => this.setSuspended(c, !c.suspended) }),
        more));
    });
    side.append(el("button", { type: "button", class: "link", onclick: () => this.createAgenda() }, icon("mdi:calendar-plus"), "Nouvel agenda"));
    const others = this.otherCalendars();
    if (others.length) {
      side.append(el("div", { class: "sidehead", text: "Autres calendriers · pour information" }));
      const sel = new Set(this.prefs.others || []);
      for (const id of others) {
        const color = this.otherColor(id);
        const on = sel.has(id);
        side.append(el("div", { class: "calrow" },
          el("span", { class: "calbox", style: `border-color:${color};${on ? "background:" + color : ""}`,
            onclick: () => { if (on) sel.delete(id); else sel.add(id); this.setPrefs({ others: [...sel] }); this.reload(); } }, on ? icon("mdi:check") : null),
          el("div", { style: "min-width:0" }, el("div", { text: friendly(this._hass, id) }))));
      }
    }
    return side;
  }

  renderMain() {
    const main = el("div", { class: "main" });
    let content;
    switch (this.view) {
      case "month": content = this.renderMonth(); break;
      case "house": content = this.renderHouse(); break;
      case "list": content = this.renderList(); break;
      case "runs": content = this.renderRuns(); break;
      default: content = this.renderWeek();
    }
    main.append(content);
    if (!this._cals.length) {
      main.replaceChildren(el("div", { class: "empty" }, el("p", { text: "Aucun agenda Local Agenda pour l'instant." }),
        el("button", { type: "button", class: "btn primary", onclick: () => this.createAgenda() }, icon("mdi:calendar-plus"), "Créer un agenda")));
      return main;
    }
    const narrow = this.isNarrow;
    main.append(el("button", { type: "button", class: `fab ${narrow ? "round" : ""}`, "aria-label": "Ajouter un événement", onclick: () => this.newEvent() },
      icon("mdi:plus"), narrow ? null : "Ajouter un événement"));
    return main;
  }

  // ---------- week / day ----------
  renderWeek() {
    const [a, b] = this.range();
    const days = [];
    for (let d = a; d < b; d += DAY) days.push(d);
    const today = dayOf(this.now);
    const cols = `48px repeat(${days.length}, minmax(0, 1fr))`;
    const items = this.items();
    const head = el("div", { class: "wk-head", style: `grid-template-columns:${cols}` }, el("div"),
      ...days.map(d => el("div", { class: `d ${d === today ? "today" : ""}` }, DAYS_SHORT[weekday(d)], el("b", { text: new Date(d * 60000).getUTCDate() }))));
    const allday = el("div", { class: "wk-allday", style: `grid-template-columns:${cols}` }, el("div", { class: "hint", style: "font-size:11px;padding:3px", text: "journée" }));
    for (const d of days) {
      const cell = el("div", { class: "cell" });
      for (const it of items.filter(x => x.allDay && x.s < d + DAY && x.e > d)) cell.append(this.chip(it));
      allday.append(cell);
    }
    const hours = el("div", { class: "wk-hours", style: `height:${24 * HOUR}px` },
      ...Array.from({ length: 23 }, (_, h) => el("span", { style: `top:${(h + 1) * HOUR}px`, text: `${pad2(h + 1)}:00` })));
    const grid = el("div", { class: "wk-grid", style: `grid-template-columns:${cols};--hour:${HOUR}px` }, hours);
    this._cols = [];
    for (const d of days) {
      const col = el("div", { class: `wk-col ${d === today ? "today" : ""}`, style: `height:${24 * HOUR}px` });
      col.dataset.day = String(d);
      this._cols.push({ day: d, col });
      col.addEventListener("click", (e) => {
        if (e.target !== col) return;
        const r = col.getBoundingClientRect();
        const min = Math.floor(((e.clientY - r.top) / HOUR) * 60 / 30) * 30;
        this.newEvent(d + min);
      });
      const timed = items.filter(x => !x.allDay && x.s < d + DAY && x.e > d)
        .map(x => ({ ...x, cs: Math.max(x.s, d), ce: Math.min(x.e, d + DAY) }))
        .map(x => ({ ...x, s: x.cs, e: Math.max(x.ce, x.cs + 20) }));
      layoutColumns(timed);
      for (const it of timed) col.append(this.block(it, d));
      if (d === today) col.append(el("div", { class: "nowline", style: `top:${((this.now - d) / 60) * HOUR}px` }));
      grid.append(col);
    }
    const wrap = el("div", { class: "scroll" }, grid);
    const box = el("div", { style: "display:flex;flex-direction:column;min-height:0;flex:1" }, head, allday, wrap);
    return box;
  }

  chip(it) {
    const c = el("div", { class: `chip-ev ${it.kind === "other" ? "other" : ""}`, style: `--agenda:${it.agenda};--evc:${it.evc}`,
      title: it.summary, text: `${it.allDay ? "" : wTime(it.s) + " "}${it.summary}` });
    if (it.kind === "local") c.addEventListener("click", (e) => { e.stopPropagation(); this.openOcc(it); });
    return c;
  }

  block(it, day) {
    const top = ((it.cs - day) / 60) * HOUR;
    const height = Math.max(((it.ce - it.cs) / 60) * HOUR, 18);
    const width = 100 / (it.cols || 1);
    const cls = ["ev"];
    if (it.kind === "other") cls.push("other");
    if (this.conditionsKo(it)) cls.push("ko");
    if (it.cal && it.cal.suspended) cls.push("susp");
    const o = it.occ || {};
    const marks = el("span", { class: "marks" },
      o.icon ? icon(o.icon) : null,
      o.actions && Object.keys(o.actions).length ? icon("mdi:flash") : null,
      o.rrule ? icon("mdi:repeat") : null,
      o.is_exception ? icon("mdi:pencil") : null);
    const b = el("div", {
      class: cls.join(" "),
      style: `top:${top}px;height:${height}px;left:calc(${(it.lane || 0) * width}% + 2px);width:calc(${width}% - 4px);--agenda:${it.agenda};--evc:${it.evc}`,
      title: `${it.summary} · ${it.allDay ? "journée" : wTime(it.s) + "–" + wTime(it.e)}`,
    }, el("div", { class: "t", text: it.summary }),
      height > 30 ? el("div", { class: "h", text: `${wTime(it.cs)}–${wTime(it.ce)}` }) : null,
      it.kind === "local" ? marks : null,
      it.kind === "local" ? el("div", { class: "resize" }) : null);
    if (it.kind === "local") this.wireDrag(b, it);
    return b;
  }

  // Mouse and pen: drag to move, drag the bottom edge to resize.  Touch: tap opens.
  wireDrag(b, it) {
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const resize = !!e.target.closest(".resize");
      const startX = e.clientX, startY = e.clientY;
      const orig = { top: b.offsetTop, height: b.offsetHeight, col: b.parentElement };
      const touch = e.pointerType === "touch";
      let dragging = false;
      let delta = 0, dayShift = 0;
      const move = (ev) => {
        if (touch) return;
        if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        if (!dragging) {
          dragging = true;
          try { b.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
          b.classList.add("dragging");
        }
        delta = Math.round(((ev.clientY - startY) / HOUR) * 60 / SNAP) * SNAP;
        if (resize) {
          b.style.height = `${Math.max(orig.height + (delta / 60) * HOUR, (SNAP / 60) * HOUR)}px`;
        } else {
          b.style.top = `${orig.top + (delta / 60) * HOUR}px`;
          const target = this._cols.find(c => { const r = c.col.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX < r.right; });
          if (target) {
            dayShift = (target.day - Number(orig.col.dataset.day)) / DAY;
            if (b.parentElement !== target.col) target.col.append(b);
          }
        }
      };
      const up = () => {
        b.removeEventListener("pointermove", move);
        b.removeEventListener("pointerup", up);
        b.removeEventListener("pointercancel", cancel);
        if (!dragging) { this.openOcc(it); return; }
        b.classList.remove("dragging");
        let ns = it.s, ne = it.e;
        const os = wm(it.occ.start), oe = wm(it.occ.end);
        if (resize) { ns = os; ne = Math.max(oe + delta, os + SNAP); }
        else { ns = os + delta + dayShift * DAY; ne = oe + delta + dayShift * DAY; }
        if (ns === os && ne === oe) { this.renderAll(true); return; }
        this.applyMove(it, ns, ne);
      };
      // A touch that turns into a scroll cancels the pointer: nothing to undo then.
      const cancel = () => {
        b.removeEventListener("pointermove", move); b.removeEventListener("pointerup", up);
        if (dragging) { b.classList.remove("dragging"); this.renderAll(true); }
      };
      b.addEventListener("pointermove", move);
      b.addEventListener("pointerup", up);
      b.addEventListener("pointercancel", cancel);
    });
  }

  async applyMove(it, ns, ne) {
    const o = it.occ;
    let scope = "all";
    if (o.rrule) {
      scope = await this.choose(`Déplacer « ${o.summary || "sans titre"} »`, [
        ["this", "Cette occurrence"], ["future", "Celle-ci et les suivantes"], ["all", "Toute la série"]]);
      if (!scope) { this.renderAll(true); return; }
    }
    try {
      let src = o, start = ns, end = ne;
      if (o.rrule && scope === "all") {
        src = await this.ws({ type: "local_agenda/event/get", entry_id: it.entry, uid: o.uid });
        start = wm(src.start) + (ns - wm(o.start));
        end = start + (ne - ns);
      }
      const event = { summary: src.summary || "", start: wStr(start), end: wStr(end), all_day: false,
        note: src.note || "", location: src.location || "", color: src.color || null, icon: src.icon || null, actions: src.actions || {} };
      if (scope !== "this") event.rrule = src.rrule || o.rrule || null;
      const msg = { type: "local_agenda/event/save", entry_id: it.entry, uid: o.uid, scope: o.rrule ? scope : "all", event };
      if (o.rrule && scope !== "all") msg.recurrence_id = o.recurrence_id;
      await this.ws(msg);
      this.toast("Événement déplacé");
    } catch (e) {
      this.toast(`Déplacement refusé : ${e.message || e}`, null, null, "error");
    }
    this.reload();
  }

  // ---------- month ----------
  renderMonth() {
    const [a] = this.range();
    const ms = monthStart(this._anchor);
    const mEnd = addMonths(ms, 1);
    const today = dayOf(this.now);
    const items = this.items();
    const grid = el("div", { class: "mo" }, ...DAYS_SHORT.map(d => el("div", { class: "hd", text: d })));
    for (let i = 0; i < 42; i++) {
      const d = a + i * DAY;
      const dayItems = items.filter(x => x.s < d + DAY && x.e > d).sort((x, y) => (y.allDay - x.allDay) || x.s - y.s);
      const cell = el("div", { class: `c ${d < ms || d >= mEnd ? "out" : ""} ${d === today ? "today" : ""}` },
        el("span", { class: "n", text: new Date(d * 60000).getUTCDate() }));
      dayItems.slice(0, 3).forEach(it => cell.append(this.chip(it)));
      if (dayItems.length > 3) cell.append(el("span", { class: "more", text: `+${dayItems.length - 3}` }));
      cell.addEventListener("click", (e) => {
        if (e.target.closest(".chip-ev")) return;
        this._anchor = d;
        this.setView(this.isNarrow ? "week" : "house");
      });
      grid.append(cell);
    }
    return el("div", { class: "scroll" }, grid);
  }

  // ---------- house ----------
  renderHouse() {
    const d = this._anchor;
    const today = dayOf(this.now);
    const pct = (m) => `${((m - d) / DAY) * 100}%`;
    const box = el("div", { class: "house" });
    box.append(el("div", { class: "hs-row" }, el("div"), el("div", { class: "hs-axis" },
      ...[0, 3, 6, 9, 12, 15, 18, 21].map(h => el("span", { style: `position:absolute;left:${(h / 24) * 100}%`, text: `${pad2(h)}h` })))));
    const row = (name, sub, color, items, opts = {}) => {
      const inDay = items.filter(x => x.s < d + DAY && x.e > d).map(x => ({ ...x, s: Math.max(x.s, d), e: Math.min(x.e, d + DAY) }));
      const lanes = Math.max(1, assignLanes(inDay));
      const lane = el("div", { class: "hs-lane", style: `height:${lanes * 30 + 4}px` });
      for (const it of inDay) {
        const b = el("div", {
          class: `hs-b ${it.kind === "other" ? "other" : ""}`,
          style: `left:${pct(it.s)};width:calc(${pct(d + (it.e - it.s))} - 2px);top:${it.lane * 30 + 3}px;--agenda:${it.agenda};--evc:${it.evc};${opts.dim ? "opacity:.5" : ""}`,
          title: `${it.summary} · ${it.allDay ? "journée" : wTime(it.s) + "–" + wTime(it.e)}`,
        }, el("span", { text: it.summary }));
        if (it.kind === "local") b.addEventListener("click", () => this.openOcc(it));
        lane.append(b);
      }
      if (d === today) lane.append(el("div", { class: "nowline vertical", style: `left:${pct(this.now)};top:-4px;bottom:-4px;border-top:none;border-left:2px solid var(--la-danger);width:0` }));
      box.append(el("div", { class: "hs-row" },
        el("div", { class: "hs-name" }, el("span", { class: "calname" }, el("span", { class: "dot", style: `background:${color}` }), name),
          sub ? el("span", { class: "calstat", style: "margin-left:16px" }, sub) : null),
        lane));
    };
    const items = this.items();
    this._cals.forEach((c, i) => {
      if (this.hidden(c.entry_id)) return;
      row(c.name, c.suspended ? "suspendu" : null, agendaColor(c, i), items.filter(x => x.entry === c.entry_id), { dim: c.suspended });
    });
    const others = this.otherSelected();
    if (others.length) box.append(el("div", { class: "hs-sep" }));
    for (const id of others) {
      row(friendly(this._hass, id), el("span", {}, icon("mdi:calendar", ""), " pour information"), this.otherColor(id), items.filter(x => x.entry === id));
    }
    return el("div", { class: "scroll" }, box);
  }

  // ---------- list ----------
  renderList() {
    const box = el("div", { class: "list" });
    let any = false;
    this._cals.forEach((c, i) => {
      if (this.hidden(c.entry_id)) return;
      const seen = new Map();
      for (const o of this._occ[c.entry_id] || []) if (!seen.has(o.uid)) seen.set(o.uid, o);
      if (!seen.size) return;
      any = true;
      box.append(el("div", { class: "lgroup" }, el("span", { class: "dot", style: `background:${agendaColor(c, i)}` }), c.name));
      for (const o of [...seen.values()].sort((x, y) => wm(x.start) - wm(y.start))) {
        const s = wm(o.start);
        const na = phaseSteps((o.actions || {}).on_start).length, nb = phaseSteps((o.actions || {}).on_stop).length;
        const nc = phaseConditions((o.actions || {}).on_start).length + phaseConditions((o.actions || {}).on_stop).length;
        const acts = [na ? `${na} au démarrage` : null, nb ? `${nb} à la fin` : null].filter(Boolean).join(" · ");
        const actsLabel = `Action${na + nb > 1 ? "s" : ""} : ${acts}`;
        const it = { kind: "local", entry: c.entry_id, cal: c, occ: o };
        box.append(el("div", { class: "litem", onclick: () => this.openOcc(it) },
          el("span", {}, el("div", { text: fmtDay(s) }), el("div", { class: "sub", text: o.all_day ? "journée" : wTime(s) })),
          el("span", { class: "dot", style: `background:${o.color || agendaColor(c, i)}` }),
          el("span", {}, el("div", { text: o.summary || "(sans titre)" }), el("div", { class: "sub", text: describeRrule(o.rrule, o.start) })),
          el("span", { class: "row", style: "justify-content:flex-end" },
            acts ? el("span", { class: "tag info", text: actsLabel }) : el("span", { class: "tag", text: "sans action" }),
            nc ? el("span", { class: "tag", text: `${nc} condition${nc > 1 ? "s" : ""}` }) : null)));
      }
    });
    if (!any) box.append(el("div", { class: "empty", text: "Aucun événement dans les deux prochains mois." }));
    return el("div", { class: "scroll" }, box);
  }

  // ---------- executions ----------
  renderRuns() {
    const box = el("div", { class: "list" });
    const now = this.now;
    const upcoming = [];
    this._cals.forEach((c, i) => {
      if (this.hidden(c.entry_id)) return;
      for (const o of this._occ[c.entry_id] || []) {
        const a = o.actions || {};
        for (const [phase, t] of [["on_start", wm(o.start)], ["on_stop", wm(o.end)]]) {
          if (!a[phase] || t < now || t >= now + DAY) continue;
          upcoming.push({ t, phase, o, c, color: agendaColor(c, i) });
        }
      }
    });
    upcoming.sort((x, y) => x.t - y.t || (x.phase === "on_stop" ? -1 : 1));
    box.append(el("div", { class: "lgroup", text: "À venir (24 h)" }));
    if (!upcoming.length) box.append(el("div", { class: "hint", style: "padding:6px 2px", text: "Aucune action prévue dans les 24 heures." }));
    for (const u of upcoming) {
      const n = phaseSteps(u.o.actions[u.phase]).length;
      const met = phaseConditionsMet(u.o.actions[u.phase], this._hass.states);
      const tag = u.c.suspended ? el("span", { class: "tag", text: "agenda suspendu" })
        : met === null ? el("span", { class: "tag", text: "sans condition" })
          : el("span", { class: `tag ${met ? "ok" : "ko"}`, text: met ? "conditions remplies" : "non remplies en ce moment" });
      box.append(el("div", { class: "litem", onclick: () => this.openOcc({ kind: "local", entry: u.c.entry_id, cal: u.c, occ: u.o }) },
        el("span", { text: `${dayOf(u.t) === dayOf(now) ? "" : "demain "}${wTime(u.t)}` }),
        el("span", { class: "dot", style: `background:${u.color}` }),
        el("span", {}, el("div", { text: `${u.o.summary || "(sans titre)"} · ${u.phase === "on_start" ? "début" : "fin"}` }),
          el("div", { class: "sub", text: `${u.c.name} · ${n} action${n > 1 ? "s" : ""}` })),
        tag));
    }
    box.append(el("div", { class: "lgroup", style: "margin-top:20px", text: "Déjà exécuté" }));
    if (!this._history.length) box.append(el("div", { class: "hint", style: "padding:6px 2px", text: "Rien pour l'instant : les exécutions apparaîtront ici." }));
    const statusTag = (h) => {
      if (h.reason === "vanished") return ["arrêt immédiat (événement retiré)", "info"];
      if (h.status === "missed") return ["manqué (Home Assistant arrêté)", "ko"];
      if (h.status === "conditions") return ["conditions non remplies", "ko"];
      if (h.status === "error" || h.status === "invalid") return ["erreur, voir les logs", "err"];
      if (h.reason === "catch_up") return ["rattrapé au redémarrage", "info"];
      return ["exécuté", "ok"];
    };
    for (const h of this._history.slice(0, 60)) {
      const c = this.cal(h.entry_id);
      const at = h.at_wall ? wm(h.at_wall) : null;
      const [label, kind] = statusTag(h);
      const occ = (this._occ[h.entry_id] || []).find(o => o.uid === h.uid);
      box.append(el("div", { class: "litem", style: occ ? "" : "cursor:default", onclick: () => occ && this.openOcc({ kind: "local", entry: h.entry_id, cal: c, occ }) },
        el("span", { text: at === null ? "" : (dayOf(at) === dayOf(now) ? wTime(at) : `${fmtDay(at)} ${wTime(at)}`) }),
        el("span", { class: "dot", style: `background:${this.calColor(h.entry_id)}` }),
        el("span", {}, el("div", { text: `${h.summary || "(sans titre)"} · ${h.phase === "start" ? "début" : "fin"}` }),
          el("div", { class: "sub", text: c ? c.name : "" })),
        el("span", { class: `tag ${kind}`, text: label })));
    }
    return el("div", { class: "scroll" }, box);
  }

  // ---------- editing ----------
  openOcc(it) {
    if (it.kind !== "local") return;
    this.openEditor({ entryId: it.entry, occ: it.occ });
  }

  newEvent(atWall) {
    const now = this.now;
    let start = atWall;
    if (start === undefined) {
      start = this._anchor === dayOf(now) || this.view === "list" || this.view === "runs"
        ? Math.ceil((now + 1) / 60) * 60 : this._anchor + 8 * 60;
    }
    const cal = this._cals.find(c => !this.hidden(c.entry_id)) || this._cals[0];
    if (!cal) return;
    this.openEditor({ entryId: cal.entry_id, start: wStr(start), end: wStr(start + 60) });
  }

  async openEditor(opts) {
    if (this._editor) return;
    this._editor = new EventEditor(this, opts);
    try { await this._editor.open(); }
    catch (e) { this._editor = null; this.toast(`Ouverture impossible : ${e.message || e}`, null, null, "error"); }
  }

  // ---------- calendars ----------
  async setSuspended(cal, suspended) {
    try { await this.ws({ type: "local_agenda/agenda/update", entry_id: cal.entry_id, suspended }); }
    catch (e) { this.toast(`Impossible : ${e.message || e}`, null, null, "error"); }
    this.toast(suspended ? `${cal.name} suspendu : aucune action ne sera exécutée` : `${cal.name} repris`);
    this.reload();
  }

  async renameAgenda(cal) {
    const name = await this.prompt("Renommer l'agenda", cal.name);
    if (!name || name === cal.name) return;
    try { await this.ws({ type: "local_agenda/agenda/update", entry_id: cal.entry_id, name }); this.reload(); }
    catch (e) { this.toast(`Impossible : ${e.message || e}`, null, null, "error"); }
  }

  async pickAgendaColor(cal) {
    const color = await this.choose(`Couleur de « ${cal.name} »`, AGENDA_COLORS.map(c => [c, ""]), true);
    if (!color) return;
    try { await this.ws({ type: "local_agenda/agenda/update", entry_id: cal.entry_id, color }); this.reload(); }
    catch (e) { this.toast(`Impossible : ${e.message || e}`, null, null, "error"); }
  }

  async createAgenda() {
    const name = await this.prompt("Nouvel agenda", "");
    if (!name) return;
    try {
      await this.ws({ type: "local_agenda/agenda/create", name });
      this.toast(`Agenda « ${name} » créé`);
      setTimeout(() => this.reload(), 800);
    } catch (e) {
      const m = String(e.message || e);
      this.toast(m.includes("already_configured") ? "Un agenda portant ce nom existe déjà." : `Création impossible : ${m}`, null, null, "error");
    }
  }

  // ---------- small dialogs ----------
  modal(title, body, buttons) {
    return new Promise((resolve) => {
      const close = (v) => { overlay.remove(); window.removeEventListener("keydown", key); this._modalClose = null; resolve(v); };
      this._modalClose = close;
      const key = (e) => { if (e.key === "Escape") close(null); };
      const overlay = el("div", { class: "overlay", style: "align-items:center;z-index:80" },
        el("div", { class: "dialog small" },
          el("div", { class: "dlg-head" }, el("span", { class: "ttl", text: title })),
          body ? el("div", { class: "dlg-sec" }, body) : null,
          el("div", { class: "dlg-foot", style: "flex-wrap:wrap" }, el("span", { style: "flex:1" }),
            ...buttons.map(([v, label, primary]) => el("button", { type: "button", class: `btn ${primary ? "primary" : ""}`, text: label, onclick: () => close(typeof v === "function" ? v() : v) })))));
      overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(null); });
      window.addEventListener("keydown", key);
      this.shadowRoot.append(overlay);
      const f = overlay.querySelector("input");
      if (f) { f.focus(); f.select(); f.addEventListener("keydown", (e) => { if (e.key === "Enter") overlay.querySelector(".btn.primary").click(); }); }
    });
  }
  confirm(msg) { return this.modal(msg, null, [[false, "Annuler"], [true, "Confirmer", true]]).then(Boolean); }
  prompt(title, value) {
    const input = el("input", { type: "text", class: "full", value: value || "" });
    return this.modal(title, input, [[null, "Annuler"], [() => input.value.trim(), "Valider", true]]);
  }
  choose(title, options, swatches = false) {
    if (swatches) {
      const box = el("div", { class: "colors" }, ...options.map(([v]) => el("button", {
        type: "button", class: "sw", style: `width:34px;height:34px;background:${v}`, "aria-label": v,
        onclick: () => this._modalClose && this._modalClose(v) })));
      return this.modal(title, box, [[null, "Annuler"]]);
    }
    return this.modal(title, null, [[null, "Annuler"], ...options.map(([v, l], i) => [v, l, i === options.length - 1])]);
  }

  toast(msg, actionLabel = null, action = null, kind = "") {
    if (this._toastEl) this._toastEl.remove();
    const t = el("div", { class: `toast ${kind}`, role: "status" }, el("span", { text: msg }),
      actionLabel ? el("button", { type: "button", text: actionLabel, onclick: () => { t.remove(); action && action(); } }) : null);
    this._toastEl = t;
    this.shadowRoot.append(t);
    setTimeout(() => t.remove(), actionLabel ? 7000 : 3500);
  }
}

customElements.define("local-agenda-panel", LocalAgendaPanel);
