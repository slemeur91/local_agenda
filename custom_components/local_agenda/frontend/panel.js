// Local Agenda — Action Builder Panel
// Vanilla JS custom element, no build step required.
// Registered automatically by the integration via async_register_built_in_panel.

const VERSION = "1.9.0";
console.info(`%c[local_agenda] panel.js v${VERSION} loaded`, "color:#03a9f4;font-weight:bold;");

// ---------------------------------------------------------------------------
// Minimal YAML serialiser (limited to the action schema we produce)
// ---------------------------------------------------------------------------
function toYaml(obj, indent = 0) {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean") return obj ? "true" : "false";
  if (typeof obj === "number") return String(obj);
  if (typeof obj === "string") {
    if (obj === "") return '""';
    if (/[\n:#\[\]{},&*?|<>=!%@`]/.test(obj) || /^\s|\s$/.test(obj) ||
        obj === "true" || obj === "false" || obj === "null" || /^\d/.test(obj)) {
      return JSON.stringify(obj);
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return obj.map(item => {
      const v = toYaml(item, indent + 1);
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const lines = v.split("\n");
        return `${pad}- ${lines[0].trimStart()}\n${lines.slice(1).join("\n")}`;
      }
      return `${pad}- ${v}`;
    }).join("\n");
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    return keys.map(k => {
      const v = obj[k];
      if (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 0) {
        return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      }
      if (Array.isArray(v) && v.length > 0) {
        return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      }
      return `${pad}${k}: ${toYaml(v, 0)}`;
    }).join("\n");
  }
  return String(obj);
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------
const STYLES = `
:host { display: block; font-family: var(--paper-font-body1_-_font-family, sans-serif); }
* { box-sizing: border-box; }
.layout { display: flex; height: 100vh; overflow: hidden; background: var(--primary-background-color, #f5f5f5); }

/* Sidebar */
.sidebar { width: 280px; min-width: 220px; border-right: 1px solid var(--divider-color, #e0e0e0); display: flex; flex-direction: column; background: var(--card-background-color, #fff); }
.sidebar-header { padding: 16px; font-size: 18px; font-weight: 600; color: var(--primary-text-color); border-bottom: 1px solid var(--divider-color, #e0e0e0); }
.cal-list { flex: 1; overflow-y: auto; padding: 8px 0; }
.cal-item { padding: 10px 16px; cursor: pointer; border-radius: 4px; margin: 2px 8px; color: var(--primary-text-color); font-size: 14px; display: flex; align-items: center; gap: 8px; transition: background .15s; }
.cal-item:hover { background: var(--secondary-background-color, #f5f5f5); }
.cal-item.active { background: var(--primary-color, #03a9f4); color: #fff; }
.cal-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--primary-color, #03a9f4); flex-shrink: 0; }
.cal-item.active .cal-dot { background: rgba(255,255,255,.7); }

/* Event list */
.event-panel { width: 260px; min-width: 200px; border-right: 1px solid var(--divider-color, #e0e0e0); display: flex; flex-direction: column; background: var(--secondary-background-color, #f9f9f9); }
.panel-header { padding: 8px 16px; font-size: 14px; font-weight: 600; color: var(--secondary-text-color); border-bottom: 1px solid var(--divider-color, #e0e0e0); text-transform: uppercase; letter-spacing: .05em; display: flex; align-items: center; justify-content: space-between; }
.btn-refresh { background: transparent; border: none; padding: 4px 6px; cursor: pointer; color: var(--secondary-text-color); font-size: 16px; border-radius: 4px; line-height: 1; }
.btn-refresh:hover { background: var(--secondary-background-color, #f0f0f0); color: var(--primary-color, #03a9f4); }
.event-list { flex: 1; overflow-y: auto; padding: 8px 0; }
.event-item { padding: 6px 8px 6px 16px; cursor: pointer; border-left: 3px solid transparent; margin-bottom: 2px; transition: background .15s; display: flex; align-items: center; gap: 4px; }
.event-item:hover { background: var(--card-background-color, #fff); }
.event-item.active { border-left-color: var(--primary-color, #03a9f4); background: var(--card-background-color, #fff); }
.event-item.has-actions .event-name::after { content: " ⚡"; font-size: 12px; }
.event-item-info { flex: 1; min-width: 0; padding: 4px 0; }
.event-name { font-size: 14px; font-weight: 500; color: var(--primary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.event-meta { font-size: 12px; color: var(--secondary-text-color); margin-top: 2px; }
.btn-delete-event { flex-shrink: 0; background: transparent; border: none; padding: 4px 6px; border-radius: 4px; font-size: 15px; color: var(--secondary-text-color); cursor: pointer; opacity: 0; transition: opacity .15s, color .15s; line-height: 1; }
.event-item:hover .btn-delete-event { opacity: 1; }
.btn-delete-event:hover { color: #e53935 !important; background: rgba(229,57,53,.1); opacity: 1; }

/* Editor */
.editor { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.editor-header { padding: 16px 24px; border-bottom: 1px solid var(--divider-color, #e0e0e0); background: var(--card-background-color, #fff); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.editor-title { font-size: 18px; font-weight: 600; color: var(--primary-text-color); }
.editor-body { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 24px; }
.empty-state { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; color: var(--secondary-text-color); font-size: 15px; }

/* Phase blocks */
.phase-block { background: var(--card-background-color, #fff); border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.1); overflow: visible; margin-bottom: 4px; }
.phase-header { padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--divider-color, #e0e0e0); }
.phase-title { font-size: 16px; font-weight: 600; color: var(--primary-text-color); display: flex; align-items: center; gap: 8px; }
.phase-badge { font-size: 11px; padding: 2px 8px; border-radius: 12px; font-weight: 600; letter-spacing: .04em; }
.badge-start { background: #e8f5e9; color: #2e7d32; }
.badge-stop  { background: #fce4ec; color: #c62828; }
.phase-body { padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }

/* Conditions block */
.cond-block { background: var(--secondary-background-color, #f5f5f5); border-radius: 6px; padding: 12px 16px; border: 1px solid var(--divider-color, #e0e0e0); }
.cond-block-title { font-size: 13px; font-weight: 600; color: var(--secondary-text-color); margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cond-block-title-left { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; flex-wrap: wrap; }
.cond-op-sel { width: 70px; padding: 4px 6px; font-size: 13px; }
.cond-list { display: flex; flex-direction: column; gap: 8px; }
.cond-list:empty { display: none; }
.cond-card { background: var(--card-background-color, #fff); border-radius: 4px; border: 1px solid var(--divider-color, #e0e0e0); }
.cond-card-header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; }
.cond-card-header-left { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; cursor: pointer; }
.cond-card-summary { font-size: 13px; color: var(--primary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cond-card.collapsed .cond-card-body { display: none; }
.cond-card-body { padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.cond-form-row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 10px; }
.cond-current { font-size: 12px; color: var(--secondary-text-color); margin-top: 4px; }
.state-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.state-chip { background: transparent; border: 1px solid var(--divider-color, #aaa); color: var(--primary-text-color); font-size: 12px; padding: 5px 10px; }
.state-chip.selected { background: var(--primary-color, #03a9f4); border-color: var(--primary-color, #03a9f4); color: #fff; }
.cond-add-state { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.cond-add-state input[type=text] { width: 200px; }
.cond-raw { margin: 0; font-family: monospace; font-size: 12px; white-space: pre-wrap; color: var(--primary-text-color); background: var(--secondary-background-color, #f5f5f5); border-radius: 4px; padding: 8px 10px; }

/* "remplie / non remplie" badges */
.cond-status { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 12px; flex-shrink: 0; white-space: nowrap; }
.cond-status:empty { display: none; }
.cond-status.ok { background: #e8f5e9; color: #2e7d32; }
.cond-status.ko { background: #fce4ec; color: #c62828; }
.cond-status.warn { background: #fff8e1; color: #b26a00; }

/* Action rows */
.action-card { border: 1px solid var(--divider-color, #e0e0e0); border-radius: 6px; overflow: visible; margin-bottom: 4px; }
.action-card-header { padding: 10px 14px; background: var(--secondary-background-color, #f5f5f5); display: flex; align-items: center; gap: 8px; }
.action-card-header-left { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; cursor: pointer; }
.action-number { font-size: 12px; font-weight: 700; color: var(--secondary-text-color); min-width: 24px; flex-shrink: 0; }
.action-card-summary { font-size: 13px; color: var(--secondary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: none; }
.action-card.collapsed .action-card-summary { display: inline; }
.action-card.collapsed .action-card-body { display: none; }
.action-card-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }

/* Collapse chevron */
.btn-collapse { background: transparent; border: none; padding: 2px 5px; cursor: pointer; color: var(--secondary-text-color); font-size: 18px; border-radius: 4px; line-height: 1; flex-shrink: 0; }
.btn-collapse:hover { background: rgba(0,0,0,.06); color: var(--primary-color, #03a9f4); }

/* Reorder buttons */
.btn-order { background: transparent; border: none; padding: 2px 5px; cursor: pointer; color: var(--secondary-text-color); font-size: 18px; font-weight: 700; border-radius: 4px; line-height: 1; flex-shrink: 0; }
.btn-order:hover:not(:disabled) { background: rgba(0,0,0,.06); color: var(--primary-color, #03a9f4); }
.btn-order:disabled { opacity: .25; cursor: default; }
.order-btns { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }

/* Form elements */
select, input[type=text], textarea {
  width: 100%; padding: 8px 10px; border: 1px solid var(--divider-color, #ccc);
  border-radius: 4px; font-size: 14px; background: var(--card-background-color, #fff);
  color: var(--primary-text-color); font-family: inherit;
}
select:focus, input:focus, textarea:focus { outline: none; border-color: var(--primary-color, #03a9f4); }
textarea { resize: vertical; min-height: 60px; font-family: monospace; font-size: 13px; }
label { font-size: 12px; font-weight: 600; color: var(--secondary-text-color); display: block; margin-bottom: 4px; }

/* Buttons */
button { cursor: pointer; border: none; border-radius: 4px; font-size: 13px; font-weight: 500; padding: 8px 14px; font-family: inherit; transition: opacity .15s; }
button:hover { opacity: .85; }
.btn-primary { background: var(--primary-color, #03a9f4); color: #fff; padding: 10px 24px; font-size: 14px; }
.btn-secondary { background: transparent; border: 1px solid var(--divider-color, #aaa); color: var(--primary-text-color); }
.btn-add { background: var(--primary-color, #03a9f4); color: #fff; font-size: 12px; padding: 6px 12px; }
.btn-icon { background: transparent; padding: 4px 6px; color: var(--secondary-text-color); font-size: 16px; border: none; }
.btn-icon:hover { color: #f44336; }

/* Data section */
.data-section { border: 1px dashed var(--divider-color, #ccc); border-radius: 4px; padding: 10px 12px; }
.data-section-title { font-size: 12px; font-weight: 600; color: var(--secondary-text-color); margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
.data-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; align-items: center; margin-bottom: 6px; }
.data-row input { margin: 0; }
.data-hint { font-size: 11px; color: var(--secondary-text-color); margin-top: 4px; font-style: italic; }

/* Filterable autocomplete */
.la-autocomplete { position: relative; width: 100%; }
.la-autocomplete input { width: 100%; }
.la-dropdown {
  position: absolute; top: 100%; left: 0; right: 0;
  max-height: 220px; overflow-y: auto;
  background: var(--card-background-color, #fff);
  border: 1px solid var(--primary-color, #03a9f4);
  border-top: none; border-radius: 0 0 6px 6px;
  z-index: 9999; display: none;
  box-shadow: 0 6px 16px rgba(0,0,0,.18);
}
.la-dropdown-item {
  padding: 7px 12px; cursor: pointer; font-size: 13px;
  border-bottom: 1px solid var(--divider-color, #eee);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--primary-text-color);
}
.la-dropdown-item:last-child { border-bottom: none; }
.la-dropdown-item:hover, .la-dropdown-item.la-active {
  background: var(--primary-color, #03a9f4); color: #fff;
}
.la-dropdown-item strong { font-weight: 700; text-decoration: underline; }
.la-dropdown-count { padding: 4px 12px; font-size: 11px; color: var(--secondary-text-color); text-align: right; font-style: italic; border-top: 1px solid var(--divider-color,#eee); }

/* Toast */
.toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 6px; font-size: 14px; font-weight: 500; z-index: 9999; opacity: 0; transition: opacity .3s; pointer-events: none; }
.toast.show { opacity: 1; }
.toast.success { background: #43a047; color: #fff; }
.toast.error   { background: #e53935; color: #fff; }

.loading { text-align: center; padding: 40px; color: var(--secondary-text-color); }
`;

// ---------------------------------------------------------------------------
// Helper: call HA WebSocket
// ---------------------------------------------------------------------------
function callWS(hass, msg) {
  return hass.callWS(msg);
}

// TARGET fields that belong in the target section, not in data
const TARGET_FIELDS = new Set(["entity_id", "area_id", "device_id"]);

// Maps a service-data field name to the entity attribute that holds its
// known list of valid values — e.g. input_select/select "option" → state
// attribute "options". Used to turn a plain text value field into a
// filterable dropdown built from the *current* values exposed by the
// selected target entity, instead of free text.
const FIELD_OPTION_ATTR = {
  option: "options",                 // input_select.select_option, select.select_option
  hvac_mode: "hvac_modes",           // climate.set_hvac_mode
  preset_mode: "preset_modes",       // climate.set_preset_mode, fan.set_preset_mode
  fan_mode: "fan_modes",             // climate.set_fan_mode
  swing_mode: "swing_modes",         // climate.set_swing_mode
  mode: "available_modes",           // humidifier.set_mode
  source: "source_list",             // media_player.select_source
  sound_mode: "sound_mode_list",     // media_player.select_sound_mode
  fan_speed: "fan_speed_list",       // vacuum.set_fan_speed
  operation_mode: "operation_list",  // water_heater.set_operation_mode
};

/**
 * Resolve the list of known valid values for a given data field, based on
 * the attributes of the currently selected target entity (uses the first
 * one if several entities are targeted).
 */
function getFieldOptions(fieldKey, targetVal, entityAttrs) {
  const attrName = FIELD_OPTION_ATTR[(fieldKey || "").trim().toLowerCase()];
  if (!attrName || !targetVal) return [];
  const firstEntity = targetVal.split(",")[0].trim();
  const attrs = entityAttrs && entityAttrs[firstEntity];
  if (!attrs) return [];
  const list = attrs[attrName];
  return Array.isArray(list) ? list.map(String) : [];
}

// ---------------------------------------------------------------------------
// Filterable autocomplete input
// ---------------------------------------------------------------------------
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Creates a text input with a live-filtered dropdown.
 *
 * @param {object} opts
 *   placeholder  – input placeholder text
 *   value        – initial value
 *   options      – string[] full list of completions
 *   className    – CSS class(es) added to the <input> element
 *   maxResults   – max items shown (default 60)
 *   onSelect     – callback(selectedValue) called when an option is chosen
 * @returns {{ wrapper: HTMLElement, input: HTMLInputElement }}
 */
function makeFilterableInput({ placeholder = "", value = "", options: initialOptions = [], className = "", maxResults = 60, onSelect = null } = {}) {
  let options = initialOptions;
  const wrapper = document.createElement("div");
  wrapper.className = "la-autocomplete";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.value = value;
  if (className) input.className = className;

  const dropdown = document.createElement("div");
  dropdown.className = "la-dropdown";

  let activeIdx = -1;
  let visible = [];

  function computeVisible(text) {
    const f = text.toLowerCase().trim();
    if (!f) return options.slice(0, maxResults);
    return options.filter(o => o.toLowerCase().includes(f)).slice(0, maxResults);
  }

  function openWith(text) {
    visible = computeVisible(text);
    activeIdx = -1;
    dropdown.innerHTML = "";
    if (!visible.length) { dropdown.style.display = "none"; return; }

    const f = text.toLowerCase().trim();
    visible.forEach((opt, i) => {
      const item = document.createElement("div");
      item.className = "la-dropdown-item";
      if (f) {
        const lo = opt.toLowerCase();
        const idx = lo.indexOf(f);
        if (idx >= 0) {
          item.innerHTML =
            escHtml(opt.substring(0, idx)) +
            "<strong>" + escHtml(opt.substring(idx, idx + f.length)) + "</strong>" +
            escHtml(opt.substring(idx + f.length));
        } else {
          item.textContent = opt;
        }
      } else {
        item.textContent = opt;
      }
      item.onmousedown = e => { e.preventDefault(); choose(opt); };
      item.onmouseenter = () => { activeIdx = i; highlight(); };
      dropdown.appendChild(item);
    });

    // count hint if many results were trimmed
    const total = computeVisible.length; // same filter
    if (options.filter(o => !f || o.toLowerCase().includes(f)).length > maxResults) {
      const hint = document.createElement("div");
      hint.className = "la-dropdown-count";
      hint.textContent = `${visible.length} résultats affichés (saisissez pour affiner)`;
      dropdown.appendChild(hint);
    }

    dropdown.style.display = "block";
  }

  function highlight() {
    Array.from(dropdown.querySelectorAll(".la-dropdown-item")).forEach((el, i) => {
      el.classList.toggle("la-active", i === activeIdx);
    });
  }

  function choose(opt) {
    input.value = opt;
    dropdown.style.display = "none";
    if (onSelect) onSelect(opt);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  input.addEventListener("input", () => openWith(input.value));
  input.addEventListener("focus", () => openWith(input.value));
  input.addEventListener("blur", () => setTimeout(() => { dropdown.style.display = "none"; }, 160));
  input.addEventListener("keydown", e => {
    if (dropdown.style.display === "none") return;
    const items = dropdown.querySelectorAll(".la-dropdown-item");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      highlight();
      items[activeIdx]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      highlight();
      items[activeIdx]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      choose(visible[activeIdx]);
    } else if (e.key === "Escape") {
      dropdown.style.display = "none";
    }
  });

  wrapper.append(input, dropdown);

  // Allows callers to swap the completion list after creation (e.g. narrowing
  // the entity list down to a domain once a service is selected).
  function setOptions(newOptions) {
    options = newOptions || [];
  }

  return { wrapper, input, setOptions };
}

// ---------------------------------------------------------------------------
// Data row (key / value pair inside a service's data section)
// ---------------------------------------------------------------------------
/**
 * Builds the value field for a data row — a plain text input by default,
 * or a filterable dropdown when `options` (the entity's known valid values)
 * is non-empty. Always exposes the underlying <input class="data-value">
 * so readDataRows() keeps working unchanged either way.
 */
function makeDataValueField(value = "", options = []) {
  if (options && options.length) {
    const { wrapper } = makeFilterableInput({
      placeholder: "valeur", value, options, className: "data-value",
    });
    return wrapper;
  }
  const input = document.createElement("input");
  input.type = "text"; input.placeholder = "valeur"; input.value = value;
  input.className = "data-value";
  return input;
}

function makeDataRow(key = "", value = "", options = []) {
  const row = document.createElement("div");
  row.className = "data-row";

  const kInput = document.createElement("input");
  kInput.type = "text"; kInput.placeholder = "clé"; kInput.value = key;
  kInput.className = "data-key";

  const vField = makeDataValueField(value, options);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn-icon"; del.textContent = "✕"; del.title = "Supprimer";
  del.onclick = () => row.remove();

  row.append(kInput, vField, del);
  return row;
}

function readDataRows(container) {
  const result = {};
  container.querySelectorAll(".data-row").forEach((row) => {
    const kEl = row.querySelector(".data-key");
    const vEl = row.querySelector(".data-value");
    const k = kEl ? kEl.value.trim() : "";
    const v = vEl ? vEl.value.trim() : "";
    // Skip entries where key OR value is empty — an empty value passed to a
    // service call causes failures (e.g. auto-suggested fields left blank).
    if (k && v !== "") result[k] = v;
  });
  return result;
}

// ---------------------------------------------------------------------------
// Condition cards
// ---------------------------------------------------------------------------
// The form only produces what actions.py knows how to evaluate: a `state`
// condition on one entity with one or several expected states, optionally
// wrapped in `not` ("n'est pas"). Anything else found in an event (nested
// and/or, extra keys, non-text states, …) is kept verbatim in a read-only
// card, so saving from the panel never drops a hand-written condition.

// States offered as buttons when the entity itself doesn't list its options.
const DOMAIN_STATES = {
  binary_sensor: ["on", "off"],
  switch: ["on", "off"],
  light: ["on", "off"],
  fan: ["on", "off"],
  input_boolean: ["on", "off"],
  automation: ["on", "off"],
  script: ["on", "off"],
  siren: ["on", "off"],
  humidifier: ["on", "off"],
  remote: ["on", "off"],
  person: ["home", "not_home"],
  device_tracker: ["home", "not_home"],
  cover: ["open", "closed", "opening", "closing"],
  valve: ["open", "closed", "opening", "closing"],
  lock: ["locked", "unlocked"],
  sun: ["above_horizon", "below_horizon"],
  vacuum: ["cleaning", "docked", "paused", "idle", "returning", "error"],
  media_player: ["playing", "paused", "idle", "off", "on", "standby"],
  timer: ["active", "paused", "idle"],
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasOnlyKeys(obj, allowed) {
  return Object.keys(obj).every(k => allowed.includes(k));
}

// True for `{condition: or, conditions: [...]}` with nothing else — the shape
// the "OU" selector reads and writes.
function isOrWrapper(cond) {
  return isPlainObject(cond) && cond.condition === "or" &&
    hasOnlyKeys(cond, ["condition", "conditions"]) && Array.isArray(cond.conditions);
}

/**
 * Turns a stored condition into the form model {entity, states, negate},
 * or returns null when the form can't represent it faithfully.
 */
function parseSimpleCond(cond) {
  if (!isPlainObject(cond)) return null;
  let c = cond;
  let negate = false;
  if (c.condition === "not") {
    if (!hasOnlyKeys(c, ["condition", "conditions"]) ||
        !Array.isArray(c.conditions) || c.conditions.length !== 1) return null;
    negate = true;
    c = c.conditions[0];
    if (!isPlainObject(c)) return null;
  }
  if (c.condition !== "state" || !hasOnlyKeys(c, ["condition", "entity_id", "state"])) return null;
  if (typeof c.entity_id !== "string") return null;
  let states;
  if (Array.isArray(c.state)) states = c.state;
  else if (c.state === undefined || c.state === "") states = [];
  else states = [c.state];
  // Unquoted YAML such as `state: on` or `state: 5` arrives as a boolean or
  // a number; the form would silently turn it into different text.
  if (states.some(s => typeof s !== "string")) return null;
  return { entity: c.entity_id, states: states.slice(), negate };
}

// Python's str() for the scalar types YAML can yield — the backend compares
// the entity state with str(expected).
function pyStr(v) {
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null || v === undefined) return "None";
  return String(v);
}

// Mirrors _check_single_condition() in actions.py, so the "remplie" badges
// show what the scheduler would decide right now.
function evalCondition(cond, states) {
  if (!isPlainObject(cond)) return false;
  const subs = Array.isArray(cond.conditions) ? cond.conditions : [];
  switch (cond.condition) {
    case "state": {
      const st = states[cond.entity_id];
      if (!st) return false;
      if (Array.isArray(cond.state)) return cond.state.includes(st.state);
      return st.state === pyStr(cond.state);
    }
    case "or": return subs.some(s => evalCondition(s, states));
    case "and": return subs.every(s => evalCondition(s, states));
    case "not": return !subs.some(s => evalCondition(s, states));
    default: return true; // the backend lets unknown condition types pass
  }
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

function setStatus(el, kind, text) {
  el.className = "cond-status" + (kind ? " " + kind : "");
  el.textContent = text;
}

/**
 * One condition card. `getStates` returns the live hass.states map.
 * The card exposes, for makePhaseBlock / readPhaseBlock:
 *   card._laRead()    → the condition to store, or null for a blank card
 *   card._laError()   → a message when the card is half filled, else null
 *   card._laRefresh() → re-reads the live states (current value + badge)
 */
function makeCondCard(cond, entityList = [], orderVal = 0, getStates = () => ({}), startCollapsed = false) {
  const isNew = !cond || Object.keys(cond).length === 0;
  const model = isNew ? { entity: "", states: [], negate: false } : parseSimpleCond(cond);

  const card = document.createElement("div");
  card.className = "cond-card";
  card.dataset.order = String(orderVal);

  const hdr = document.createElement("div");
  hdr.className = "cond-card-header";

  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "btn-collapse";
  collapseBtn.title = "Déplier / replier";

  const summarySpan = document.createElement("span");
  summarySpan.className = "cond-card-summary";

  const headerLeft = document.createElement("div");
  headerLeft.className = "cond-card-header-left";
  headerLeft.append(collapseBtn, summarySpan);

  const statusSpan = document.createElement("span");
  statusSpan.className = "cond-status";

  const orderBtns = document.createElement("div");
  orderBtns.className = "order-btns";
  const upBtn = document.createElement("button");
  upBtn.type = "button"; upBtn.className = "btn-order btn-order-up"; upBtn.textContent = "↑"; upBtn.title = "Monter";
  const downBtn = document.createElement("button");
  downBtn.type = "button"; downBtn.className = "btn-order btn-order-down"; downBtn.textContent = "↓"; downBtn.title = "Descendre";
  orderBtns.append(upBtn, downBtn);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn-icon btn-delete-cond"; del.textContent = "🗑"; del.title = "Supprimer la condition";
  // .remove() / reorder side-effects are wired from makePhaseBlock.

  hdr.append(headerLeft, statusSpan, orderBtns, del);

  const body = document.createElement("div");
  body.className = "cond-card-body";

  function setCollapsed(collapsed) {
    card.classList.toggle("collapsed", collapsed);
    collapseBtn.textContent = collapsed ? "▸" : "▾";
  }
  headerLeft.onclick = () => setCollapsed(!card.classList.contains("collapsed"));
  setCollapsed(startCollapsed);

  card.append(hdr, body);

  // ---- Hand-written condition the form can't represent: shown as is ----
  if (!model) {
    summarySpan.textContent = "Condition avancée (non modifiable ici)";
    const pre = document.createElement("pre");
    pre.className = "cond-raw";
    try { pre.textContent = toYaml(cond); } catch (e) { pre.textContent = JSON.stringify(cond, null, 2); }
    const hint = document.createElement("div");
    hint.className = "data-hint";
    hint.textContent = "Écrite à la main dans la description de l'événement : elle est conservée telle quelle à la sauvegarde.";
    body.append(pre, hint);

    card._laRead = () => cond;
    card._laError = () => null;
    card._laRefresh = () => {
      const met = evalCondition(cond, getStates());
      setStatus(statusSpan, met ? "ok" : "ko", met ? "remplie" : "non remplie");
    };
    card._laRefresh();
    return card;
  }

  // ---- Form: entity + comparison ----
  const formRow = document.createElement("div");
  formRow.className = "cond-form-row";

  const entityGroup = document.createElement("div");
  const entityLabel = document.createElement("label"); entityLabel.textContent = "Entité";
  const { wrapper: entityWrapper, input: entityInput } = makeFilterableInput({
    placeholder: "entity_id",
    value: model.entity,
    options: entityList,
    className: "cond-entity-input",
  });
  const currentEl = document.createElement("div");
  currentEl.className = "cond-current";
  entityGroup.append(entityLabel, entityWrapper, currentEl);

  const compareGroup = document.createElement("div");
  const compareLabel = document.createElement("label"); compareLabel.textContent = "Comparaison";
  const compareSel = document.createElement("select");
  compareSel.className = "cond-compare-sel";
  [{ v: "is", l: "est" }, { v: "is_not", l: "n'est pas" }].forEach(({ v, l }) => {
    const o = document.createElement("option"); o.value = v; o.textContent = l;
    compareSel.appendChild(o);
  });
  compareSel.value = model.negate ? "is_not" : "is";
  compareGroup.append(compareLabel, compareSel);

  formRow.append(entityGroup, compareGroup);

  // ---- States: multi-select buttons + free entry ----
  const statesGroup = document.createElement("div");
  const statesLabel = document.createElement("label"); statesLabel.textContent = "États (choix multiple)";
  const chips = document.createElement("div");
  chips.className = "state-chips";
  const addRow = document.createElement("div");
  addRow.className = "cond-add-state";
  const otherInput = document.createElement("input");
  otherInput.type = "text"; otherInput.placeholder = "Autre état";
  const addBtn = document.createElement("button");
  addBtn.type = "button"; addBtn.className = "btn-secondary"; addBtn.textContent = "Ajouter";
  addRow.append(otherInput, addBtn);
  statesGroup.append(statesLabel, chips, addRow);

  body.append(formRow, statesGroup);

  const selected = model.states.slice();
  const entityId = () => entityInput.value.trim();
  const notifyChanged = () => card.dispatchEvent(new Event("change", { bubbles: true }));

  function renderChips() {
    const e = entityId();
    const list = knownStates(e, getStates()[e]);
    selected.forEach(s => { if (!list.includes(s)) list.push(s); });
    chips.innerHTML = "";
    if (!list.length) {
      const empty = document.createElement("span");
      empty.className = "data-hint";
      empty.textContent = e ? "Aucun état connu pour cette entité : ajoutez-le ci-dessous." : "Choisissez d'abord une entité.";
      chips.appendChild(empty);
      return;
    }
    list.forEach(s => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "state-chip" + (selected.includes(s) ? " selected" : "");
      chip.textContent = s;
      chip.onclick = () => {
        const i = selected.indexOf(s);
        if (i === -1) selected.push(s); else selected.splice(i, 1);
        renderChips();
        refresh();
        notifyChanged();
      };
      chips.appendChild(chip);
    });
  }

  function commitOther() {
    const v = otherInput.value.trim();
    if (!v) return;
    otherInput.value = "";
    if (!selected.includes(v)) selected.push(v);
    renderChips();
    refresh();
    notifyChanged();
  }
  // "change" fires on Enter and on blur, so a state typed but not yet added
  // is picked up before a click on "Sauvegarder" is handled.
  otherInput.addEventListener("change", (ev) => { ev.stopPropagation(); commitOther(); });
  addBtn.onclick = commitOther;

  function read() {
    const e = entityId();
    if (!e && !selected.length) return null;
    const c = { condition: "state", entity_id: e, state: selected.length === 1 ? selected[0] : selected.slice() };
    return compareSel.value === "is_not" ? { condition: "not", conditions: [c] } : c;
  }

  function error() {
    const e = entityId();
    if (!e && !selected.length) return null;
    if (!e) return "choisissez une entité";
    if (!selected.length) return "choisissez au moins un état";
    return null;
  }

  function refresh() {
    const e = entityId();
    const st = getStates()[e];
    const name = (st && st.attributes && st.attributes.friendly_name) || e;
    if (st) currentEl.textContent = `${name} · actuellement : ${st.state}`;
    else currentEl.textContent = e ? "Entité inconnue de Home Assistant" : "";

    const verb = compareSel.value === "is_not" ? "n'est pas" : "est";
    summarySpan.textContent = e || selected.length
      ? `${name || "(entité non définie)"} ${verb} ${selected.join(", ") || "(état non défini)"}`
      : "Nouvelle condition";

    if (!e && !selected.length) setStatus(statusSpan, "", "");
    else if (error()) setStatus(statusSpan, "warn", "incomplète");
    else {
      const met = evalCondition(read(), getStates());
      setStatus(statusSpan, met ? "ok" : "ko", met ? "remplie" : "non remplie");
    }
  }

  function onEntityChanged() { renderChips(); refresh(); }
  entityInput.addEventListener("input", onEntityChanged);
  entityInput.addEventListener("change", onEntityChanged);
  compareSel.addEventListener("change", refresh);

  card._laRead = read;
  card._laError = error;
  card._laRefresh = refresh;

  renderChips();
  refresh();
  return card;
}

// ---------------------------------------------------------------------------
// Action card
// ---------------------------------------------------------------------------
function makeActionCard(orderVal, actionData, servicesMap, entityList = [], entityAttrs = {}, startCollapsed = false) {
  // Flat sorted list of "domain.service" strings derived from servicesMap
  const svcList = [];
  for (const [domain, svcs] of Object.entries(servicesMap || {})) {
    for (const svcName of Object.keys(svcs)) {
      svcList.push(`${domain}.${svcName}`);
    }
  }
  svcList.sort();

  const card = document.createElement("div");
  card.className = "action-card";
  card.dataset.order = String(orderVal);

  // Header
  const hdr = document.createElement("div");
  hdr.className = "action-card-header";

  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "btn-collapse";
  collapseBtn.title = "Déplier / replier";
  collapseBtn.textContent = "▾";

  const numSpan = document.createElement("span");
  numSpan.className = "action-number"; numSpan.textContent = "#?";

  const summarySpan = document.createElement("span");
  summarySpan.className = "action-card-summary";

  const headerLeft = document.createElement("div");
  headerLeft.className = "action-card-header-left";
  headerLeft.append(collapseBtn, numSpan, summarySpan);

  const orderBtns = document.createElement("div");
  orderBtns.className = "order-btns";
  const upBtn = document.createElement("button");
  upBtn.type = "button"; upBtn.className = "btn-order btn-order-up"; upBtn.textContent = "↑"; upBtn.title = "Monter";
  const downBtn = document.createElement("button");
  downBtn.type = "button"; downBtn.className = "btn-order btn-order-down"; downBtn.textContent = "↓"; downBtn.title = "Descendre";
  orderBtns.append(upBtn, downBtn);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn-icon btn-delete-action"; delBtn.textContent = "🗑"; delBtn.title = "Supprimer l'action";
  // .remove() / reorder side-effects (renumbering, ↑/↓ disabled state) are
  // wired from makePhaseBlock, which owns the surrounding container.

  hdr.append(headerLeft, orderBtns, delBtn);

  const body = document.createElement("div");
  body.className = "action-card-body";

  // ---- Service (filterable) ----
  const svcLabel = document.createElement("label");
  svcLabel.innerHTML = "Service HA &nbsp;<span style='font-weight:400;color:var(--secondary-text-color);'>(domaine = type d'entité)</span>";
  const { wrapper: svcWrapper, input: svcInput } = makeFilterableInput({
    placeholder: "type_entité.action  (ex: switch.turn_on, light.turn_on)",
    value: actionData.service || "",
    options: svcList,
    className: "svc-input",
  });

  // ---- Target entity_id (filterable, narrowed to the service's domain when possible) ----
  const targetLabel = document.createElement("label"); targetLabel.textContent = "Entité cible (target.entity_id)";
  const tgt = actionData.target || {};
  let targetVal = "";
  if (Array.isArray(tgt.entity_id)) targetVal = tgt.entity_id.join(", ");
  else if (tgt.entity_id) targetVal = tgt.entity_id;
  else if (actionData.entity_id) targetVal = actionData.entity_id;

  // Narrows the entity list to the domain implied by the selected service
  // (e.g. light.turn_on -> only light.* entities). If no domain can be
  // determined, or no entity of that domain exists (generic services like
  // homeassistant.turn_on, script.turn_on with no script entities, …),
  // falls back to the full unfiltered list.
  function entityOptionsForCurrentService() {
    const svcFull = svcInput.value.trim();
    const dotIdx = svcFull.indexOf(".");
    if (dotIdx <= 0) return entityList;
    const domain = svcFull.substring(0, dotIdx);
    const filtered = entityList.filter(e => e.startsWith(domain + "."));
    return filtered.length ? filtered : entityList;
  }

  const { wrapper: targetWrapper, input: targetInput, setOptions: setTargetOptions } = makeFilterableInput({
    placeholder: "light.salon  (ou plusieurs séparées par virgule)",
    value: targetVal,
    options: entityOptionsForCurrentService(),
    className: "target-input",
  });

  // ---- Data section ----
  const dataSection = document.createElement("div");
  dataSection.className = "data-section";

  const dataTitleRow = document.createElement("div");
  dataTitleRow.className = "data-section-title";
  dataTitleRow.innerHTML = "<span>Données (data)</span>";
  const addDataBtn = document.createElement("button");
  addDataBtn.type = "button";
  addDataBtn.className = "btn-add";
  addDataBtn.textContent = "+ Ajouter un champ";
  addDataBtn.style.cssText = "font-size:11px;padding:4px 8px;";
  addDataBtn.onclick = () => addDataRow();
  dataTitleRow.appendChild(addDataBtn);

  const dataContainer = document.createElement("div");
  dataContainer.className = "data-container";

  // Adds a data row whose value field is a filterable dropdown when the
  // target entity exposes a known list of values for this field (e.g.
  // "option" on an input_select/select, "hvac_mode" on a climate…),
  // falling back to free text otherwise.
  function addDataRow(key = "", value = "") {
    const options = getFieldOptions(key, targetInput.value.trim(), entityAttrs);
    const row = makeDataRow(key, value, options);
    const kEl = row.querySelector(".data-key");
    // Listen on both "input" (live, while typing — no need to blur first)
    // and "change" (covers programmatic value updates) so the dropdown
    // appears as soon as a known field name like "option" is typed.
    kEl.addEventListener("input", () => refreshRowValueField(row));
    kEl.addEventListener("change", () => refreshRowValueField(row));
    dataContainer.appendChild(row);
    return row;
  }

  // Re-evaluates a row's value field (text vs. dropdown + options) — called
  // when its key changes, or when the target entity changes.
  function refreshRowValueField(row) {
    const kEl = row.querySelector(".data-key");
    const key = kEl ? kEl.value.trim() : "";
    const valEl = row.querySelector(".data-value");
    if (!valEl) return;
    const oldVal = valEl.value;
    const options = getFieldOptions(key, targetInput.value.trim(), entityAttrs);
    const newField = makeDataValueField(oldVal, options);
    const oldField = valEl.closest(".la-autocomplete") || valEl;
    oldField.replaceWith(newField);
  }

  // Pre-fill existing data fields
  const existingData = actionData.data || {};
  Object.entries(existingData).forEach(([k, v]) => {
    addDataRow(k, String(v));
  });

  const dataHint = document.createElement("div");
  dataHint.className = "data-hint";
  dataHint.textContent = "Les champs connus du service apparaissent automatiquement lors de la sélection. Si l'entité cible expose une liste de valeurs connues (input_select, select, climate…), la valeur se choisit dans une liste déroulante.";

  dataSection.append(dataTitleRow, dataContainer, dataHint);
  body.append(svcLabel, svcWrapper, targetLabel, targetWrapper, dataSection);

  // When the target entity changes, re-evaluate every row's value field
  // (e.g. switching from one input_select to another with different options).
  // Bound on both "input" and "change" so it also reacts while typing the
  // entity_id manually, not just after picking it from the dropdown/blurring.
  function refreshAllRowValueFields() {
    dataContainer.querySelectorAll(".data-row").forEach(refreshRowValueField);
  }
  targetInput.addEventListener("input", refreshAllRowValueFields);
  targetInput.addEventListener("change", refreshAllRowValueFields);

  // ---- Auto-suggest fields on service change ----
  // Tracks the last "domain.service" string we actually auto-filled for, so
  // we only clean up/repopulate the data section when the service really
  // changes to a different one — not on every keystroke while it's still
  // being typed/incomplete, and not on initial load (where the saved data
  // is assumed correct as-is).
  let lastAutoFilledService = actionData.service || "";

  function autoFillFields() {
    const svcFull = svcInput.value.trim();
    const dotIdx = svcFull.indexOf(".");
    if (dotIdx < 0) return;
    const domain = svcFull.substring(0, dotIdx);
    const svcName = svcFull.substring(dotIdx + 1);
    const svcDef = servicesMap && servicesMap[domain] && servicesMap[domain][svcName];
    if (!svcDef) return; // unrecognised/incomplete service string — leave existing rows alone

    if (svcFull !== lastAutoFilledService) {
      // The service genuinely changed (e.g. notify.* -> input_select.*):
      // drop any data row whose key isn't part of the *new* service's
      // field schema. Without this, fields like "message"/"title"/"data"
      // left over from the previous domain just sit there unused (or
      // worse, get sent as invalid extra data on the new service call).
      const validKeys = new Set(Object.keys(svcDef.fields || {}));
      Array.from(dataContainer.querySelectorAll(".data-row")).forEach(row => {
        const kEl = row.querySelector(".data-key");
        const key = kEl ? kEl.value.trim() : "";
        if (key && !validKeys.has(key)) row.remove();
      });
    }
    lastAutoFilledService = svcFull;

    if (!svcDef.fields) return;

    const existingKeys = new Set(
      Array.from(dataContainer.querySelectorAll(".data-key")).map(k => k.value.trim()).filter(Boolean)
    );

    Object.keys(svcDef.fields).forEach(field => {
      if (TARGET_FIELDS.has(field)) return;
      if (!existingKeys.has(field)) {
        addDataRow(field, "");
        existingKeys.add(field);
      }
    });

    if (svcDef.description) {
      dataHint.textContent = svcDef.description;
    }
  }

  // Listen on both "input" (live, while typing) and "change" (blur/explicit
  // pick) so narrowing the entity list, auto-filling fields, AND refreshing
  // already-existing rows' value dropdowns all happen immediately when the
  // domain/service changes — previously only "change" was handled and
  // refreshAllRowValueFields() was never called here, which is exactly why
  // selecting a new domain left stale option values until the target entity
  // field was separately re-touched.
  function onServiceChanged() {
    setTargetOptions(entityOptionsForCurrentService());
    autoFillFields();
    refreshAllRowValueFields();
  }
  svcInput.addEventListener("input", onServiceChanged);
  svcInput.addEventListener("change", onServiceChanged);
  if (actionData.service && servicesMap) autoFillFields();

  // ---- Collapse / expand ----
  function updateSummary() {
    const svc = svcInput.value.trim() || "(service non défini)";
    const tgt = targetInput.value.trim() || "(cible non définie)";
    summarySpan.textContent = `${svc} → ${tgt}`;
  }
  function setCollapsed(collapsed) {
    card.classList.toggle("collapsed", collapsed);
    collapseBtn.textContent = collapsed ? "▸" : "▾";
    if (collapsed) updateSummary();
  }
  headerLeft.onclick = () => setCollapsed(!card.classList.contains("collapsed"));
  setCollapsed(startCollapsed);

  card.append(hdr, body);
  return card;
}

function readActionCard(card) {
  const svc = card.querySelector(".svc-input").value.trim();
  const targetStr = card.querySelector(".target-input").value.trim();
  const data = readDataRows(card.querySelector(".data-container"));

  const action = {};
  if (svc) action.service = svc;
  if (targetStr) {
    const ids = targetStr.split(",").map(s => s.trim()).filter(Boolean);
    action.target = { entity_id: ids.length === 1 ? ids[0] : ids };
  }
  if (Object.keys(data).length > 0) action.data = data;
  return action;
}

// ---------------------------------------------------------------------------
// Phase block (on_start or on_stop)
// ---------------------------------------------------------------------------
// Re-sorts a reorderable list's DOM children so the most-recently-created
// (or most-recently-moved) item is visually on top — purely a display
// convenience — while each element's dataset.order (the value actually used
// to determine save/execution order in readPhaseBlock) is left untouched
// except by an explicit ↑/↓ swap. Also recomputes the "#N" badge for action
// cards (true ascending order, independent of visual position) and disables
// the ↑/↓ buttons at whichever ends of the *visual* list they'd no longer
// have an effect.
function renumberAndSort(container, selector, hasNumber = false) {
  const items = Array.from(container.querySelectorAll(selector));
  items.sort((a, b) => Number(b.dataset.order) - Number(a.dataset.order)); // newest/highest order first (top)
  items.forEach(el => container.appendChild(el));

  if (hasNumber) {
    const ascending = items.slice().sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order));
    ascending.forEach((el, i) => {
      const numEl = el.querySelector(".action-number");
      if (numEl) numEl.textContent = `#${i + 1}`;
    });
  }

  items.forEach((el, i) => {
    const upBtn = el.querySelector(".btn-order-up");
    const downBtn = el.querySelector(".btn-order-down");
    if (upBtn) upBtn.disabled = i === 0;
    if (downBtn) downBtn.disabled = i === items.length - 1;
  });
}

// Wires the ↑ / ↓ / 🗑 buttons of a single reorderable item (an action-card
// or a cond-card) once it has been appended into its container. Swapping
// dataset.order between visual neighbours is what actually changes the
// real/save order — see readPhaseBlock, which always reads items sorted by
// dataset.order ascending, never by raw DOM position.
function wireReorderableItem(el, container, selector, { hasNumber = false, deleteSelector } = {}) {
  const upBtn = el.querySelector(".btn-order-up");
  const downBtn = el.querySelector(".btn-order-down");
  const delBtn = deleteSelector ? el.querySelector(deleteSelector) : null;

  function swapWith(otherIdx, items, idx) {
    const other = items[otherIdx];
    const tmp = el.dataset.order;
    el.dataset.order = other.dataset.order;
    other.dataset.order = tmp;
    renumberAndSort(container, selector, hasNumber);
    container.dispatchEvent(new Event("change", { bubbles: true }));
  }

  if (upBtn) upBtn.onclick = () => {
    const items = Array.from(container.querySelectorAll(selector))
      .sort((a, b) => Number(b.dataset.order) - Number(a.dataset.order));
    const idx = items.indexOf(el);
    if (idx <= 0) return;
    swapWith(idx - 1, items, idx);
  };
  if (downBtn) downBtn.onclick = () => {
    const items = Array.from(container.querySelectorAll(selector))
      .sort((a, b) => Number(b.dataset.order) - Number(a.dataset.order));
    const idx = items.indexOf(el);
    if (idx === -1 || idx >= items.length - 1) return;
    swapWith(idx + 1, items, idx);
  };
  if (delBtn) delBtn.onclick = () => {
    el.remove();
    renumberAndSort(container, selector, hasNumber);
    container.dispatchEvent(new Event("change", { bubbles: true }));
  };
}

function makePhaseBlock(phase, phaseData, servicesMap, entityList = [], entityAttrs = {}, getStates = () => ({})) {
  const isStart = phase === "on_start";
  const block = document.createElement("div");
  block.className = "phase-block";
  block.dataset.phase = phase;

  const hdr = document.createElement("div");
  hdr.className = "phase-header";
  hdr.innerHTML = `
    <div class="phase-title">
      ${isStart ? "▶" : "⏹"}
      <span>${isStart ? "Au démarrage de l'événement" : "À la fin de l'événement"}</span>
      <span class="phase-badge ${isStart ? "badge-start" : "badge-stop"}">${isStart ? "on_start" : "on_stop"}</span>
    </div>`;

  const body = document.createElement("div");
  body.className = "phase-body";

  // --- Conditions ---
  const condBlock = document.createElement("div");
  condBlock.className = "cond-block";
  const condTitleRow = document.createElement("div");
  condTitleRow.className = "cond-block-title";

  let existingConds = [];
  if (phaseData && typeof phaseData === "object" && !Array.isArray(phaseData)) {
    existingConds = Array.isArray(phaseData.conditions) ? phaseData.conditions : [];
  }
  // The top-level list is an implicit AND; a single `or` wrapper around
  // everything is what the "OU" choice of the selector is stored as.
  let operator = "and";
  if (existingConds.length === 1 && isOrWrapper(existingConds[0])) {
    operator = "or";
    existingConds = existingConds[0].conditions;
  }

  const condTitleLeft = document.createElement("div");
  condTitleLeft.className = "cond-block-title-left";
  const condTitleText = document.createElement("span");
  condTitleText.textContent = "🔎 Conditions reliées par";
  const opSel = document.createElement("select");
  opSel.className = "cond-op-sel";
  opSel.title = "ET : toutes les conditions doivent être remplies. OU : une seule suffit.";
  [{ v: "and", l: "ET" }, { v: "or", l: "OU" }].forEach(({ v, l }) => {
    const o = document.createElement("option"); o.value = v; o.textContent = l;
    opSel.appendChild(o);
  });
  opSel.value = operator;
  const ruleStatus = document.createElement("span");
  ruleStatus.className = "cond-status";
  condTitleLeft.append(condTitleText, opSel, ruleStatus);

  const addCondBtn = document.createElement("button");
  addCondBtn.type = "button";
  addCondBtn.className = "btn-add"; addCondBtn.textContent = "+ Condition";
  condTitleRow.append(condTitleLeft, addCondBtn);

  const condList = document.createElement("div");
  condList.className = "cond-list";

  const condCards = () => Array.from(condList.querySelectorAll(".cond-card"));

  // Badge of the whole rule: would the service calls below run right now?
  function refreshRuleStatus() {
    const cards = condCards();
    const items = cards.map(c => c._laRead()).filter(Boolean);
    if (!items.length) setStatus(ruleStatus, "", "");
    else if (cards.some(c => c._laError())) setStatus(ruleStatus, "warn", "Règle incomplète");
    else {
      const states = getStates();
      const results = items.map(c => evalCondition(c, states));
      const met = opSel.value === "or" ? results.some(Boolean) : results.every(Boolean);
      setStatus(ruleStatus, met ? "ok" : "ko", met ? "Règle remplie" : "Règle non remplie");
    }
  }
  condBlock.addEventListener("input", refreshRuleStatus);
  condBlock.addEventListener("change", refreshRuleStatus);

  function addCondCard(cond, orderVal, startCollapsed) {
    const card = makeCondCard(cond, entityList, orderVal, getStates, startCollapsed);
    condList.appendChild(card);
    wireReorderableItem(card, condList, ".cond-card", { deleteSelector: ".btn-delete-cond" });
  }

  let nextCondOrder = existingConds.length;
  // Pre-existing conditions start collapsed (one-line summary + badge) to
  // reduce clutter on an already configured event; new ones start expanded.
  existingConds.forEach((c, i) => addCondCard(c, i, /* startCollapsed */ true));
  renumberAndSort(condList, ".cond-card");

  addCondBtn.onclick = () => {
    addCondCard({}, nextCondOrder++, /* startCollapsed */ false);
    renumberAndSort(condList, ".cond-card");
  };
  condBlock.append(condTitleRow, condList);

  // --- Actions ---
  const actionsContainer = document.createElement("div");
  actionsContainer.className = "actions-container";
  actionsContainer.style.cssText = "display:flex;flex-direction:column;gap:8px;";

  let existingActions = [];
  if (Array.isArray(phaseData)) existingActions = phaseData;
  else if (phaseData && typeof phaseData === "object") existingActions = phaseData.actions || [];

  let nextActionOrder = existingActions.length;
  existingActions.forEach((a, i) => {
    // Pre-existing actions start collapsed (one-line summary) so a long,
    // already-configured list stays scannable; only freshly added cards
    // start expanded for immediate editing.
    const card = makeActionCard(i, a, servicesMap, entityList, entityAttrs, /* startCollapsed */ true);
    actionsContainer.appendChild(card);
    wireReorderableItem(card, actionsContainer, ".action-card", { hasNumber: true, deleteSelector: ".btn-delete-action" });
  });
  renumberAndSort(actionsContainer, ".action-card", true);

  const actTitleRow = document.createElement("div");
  actTitleRow.style.cssText = "font-size:13px;font-weight:600;color:var(--secondary-text-color);display:flex;align-items:center;justify-content:space-between;margin-top:4px;";
  actTitleRow.innerHTML = "<span>⚡ Appels de service</span>";
  const addActionBtn = document.createElement("button");
  addActionBtn.type = "button";
  addActionBtn.className = "btn-add"; addActionBtn.textContent = "+ Ajouter un appel de service";
  addActionBtn.onclick = () => {
    // New card: real/save order = appended after every existing one
    // (creation order preserved), but it renders at the top of the visual
    // list (newest first) and starts expanded for immediate editing.
    const card = makeActionCard(nextActionOrder++, {}, servicesMap, entityList, entityAttrs, /* startCollapsed */ false);
    actionsContainer.appendChild(card);
    wireReorderableItem(card, actionsContainer, ".action-card", { hasNumber: true, deleteSelector: ".btn-delete-action" });
    renumberAndSort(actionsContainer, ".action-card", true);
  };
  actTitleRow.appendChild(addActionBtn);

  body.append(condBlock, actTitleRow, actionsContainer);
  block.append(hdr, body);

  // Called by the panel on every hass update so badges follow live states.
  block._laRefresh = () => {
    condCards().forEach(c => c._laRefresh());
    refreshRuleStatus();
  };
  // First half-filled condition, as a message for the save toast (or null).
  block._laError = () => {
    for (const c of condCards()) {
      const err = c._laError();
      if (err) return `${isStart ? "Au démarrage" : "À la fin"} : condition incomplète, ${err}.`;
    }
    return null;
  };
  refreshRuleStatus();
  return block;
}

function readPhaseBlock(block) {
  // Always read in *true* (saved/execution) order = ascending dataset.order
  // — independent of however the items are currently arranged on screen.
  // This stays equal to creation order unless the user has explicitly used
  // the ↑/↓ buttons on a given list, at which point the swapped order
  // values are exactly what gets read here.
  const condCards = Array.from(block.querySelectorAll(".cond-list .cond-card"))
    .sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order));
  const items = condCards.map(c => c._laRead()).filter(Boolean);
  const operator = block.querySelector(".cond-op-sel").value;
  // AND is the implicit top-level list; OR needs a wrapper (pointless around
  // a single condition).
  const conditions = operator === "or" && items.length > 1
    ? [{ condition: "or", conditions: items }]
    : items;

  const actionCards = Array.from(block.querySelectorAll(".action-card"))
    .sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order));
  const actions = actionCards.map(c => readActionCard(c)).filter(a => a.service);

  if (actions.length === 0 && conditions.length === 0) return null;
  if (conditions.length === 0) return actions;
  return { conditions, actions };
}

// ---------------------------------------------------------------------------
// Main Panel Element
// ---------------------------------------------------------------------------
class LocalAgendaPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._shadow = this.attachShadow({ mode: "open" });
    this._calendars = [];
    this._selectedCalendar = null;
    this._events = [];
    this._selectedEvent = null;
    this._servicesMap = {};  // { domain: { service: { fields: {...} } } }
    this._entityList = [];   // flat sorted list of entity_id strings
    this._entityAttrs = {};  // { entity_id: attributes } — used for known option lists
    this._currentActions = {};
    this._dirty = false;
    this._unsubUpdated = null; // unsubscribe fn for the "local_agenda_updated" bus event
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._init();
    // Keep the "remplie / non remplie" badges in sync with live states.
    else this._shadow.querySelectorAll(".phase-block").forEach(b => { if (b._laRefresh) b._laRefresh(); });
  }

  set panel(p) { this._panel = p; }

  // Backend fires "local_agenda_updated" (see LocalAgendaEntity._notify_panel_updated
  // in calendar.py) whenever an event is created/updated/deleted — from this panel,
  // HA's built-in calendar UI, an automation, anywhere. We rely on this instead of
  // watching entity state, because HA skips updating the entity's state/last_updated
  // when neither the visible state string nor its attributes actually change (e.g.
  // deleting an event that wasn't the "next upcoming" one shown by the entity).
  _subscribeToUpdates() {
    if (!this._hass || !this._hass.connection) return;
    this._hass.connection
      .subscribeEvents((ev) => {
        const entryId = ev && ev.data && ev.data.entry_id;
        if (
          this._selectedCalendar &&
          entryId === this._selectedCalendar.entry_id &&
          !this._dirty
        ) {
          this._refreshEvents();
        }
      }, "local_agenda_updated")
      .then((unsub) => { this._unsubUpdated = unsub; })
      .catch((e) => console.warn("local_agenda: could not subscribe to updates", e));
  }

  disconnectedCallback() {
    if (this._unsubUpdated) { this._unsubUpdated(); this._unsubUpdated = null; }
  }

  async _init() {
    this._render();
    // Wire up the refresh button
    const refreshBtn = this._shadow.getElementById("la-refresh-btn");
    if (refreshBtn) refreshBtn.onclick = () => this._refreshEvents();
    this._subscribeToUpdates();
    await Promise.all([this._loadCalendars(), this._loadHaData()]);
  }

  async _refreshEvents() {
    if (!this._selectedCalendar) return;
    try {
      const refreshBtn = this._shadow.getElementById("la-refresh-btn");
      if (refreshBtn) { refreshBtn.textContent = "…"; refreshBtn.disabled = true; }
      this._events = await callWS(this._hass, {
        type: "local_agenda/get_events",
        entry_id: this._selectedCalendar.entry_id,
      });
      // If the selected event no longer exists, clear the selection
      if (this._selectedEvent && !this._events.find(e => e.uid === this._selectedEvent.uid)) {
        this._selectedEvent = null;
        this._currentActions = {};
        this._dirty = false;
        this._renderEditor();
        this._showToast("L'événement sélectionné n'existe plus.", "error");
      }
      this._renderEventList();
    } catch (err) {
      this._showToast("Erreur lors du rafraîchissement : " + err, "error");
    } finally {
      const refreshBtn = this._shadow.getElementById("la-refresh-btn");
      if (refreshBtn) { refreshBtn.textContent = "↺"; refreshBtn.disabled = false; }
    }
  }

  // ---- Data loading ----

  async _loadCalendars() {
    try {
      this._calendars = await callWS(this._hass, { type: "local_agenda/list_calendars" });
      this._renderCalendarList();
    } catch (e) { this._showToast("Erreur chargement calendriers : " + e, "error"); }
  }

  async _loadHaData() {
    try {
      // Use HA's native get_services command — returns full field info per service
      const raw = await callWS(this._hass, { type: "get_services" });
      this._servicesMap = raw || {};

      // Entities + their attributes, from hass.states (always up to date).
      // Attributes feed the known-option dropdowns (input_select.options,
      // climate.hvac_modes, media_player.source_list, etc.).
      const states = this._hass.states || {};
      this._entityList = Object.keys(states).sort();
      this._entityAttrs = {};
      for (const [entityId, st] of Object.entries(states)) {
        this._entityAttrs[entityId] = (st && st.attributes) || {};
      }
    } catch (e) {
      console.warn("local_agenda: could not load HA services/entities", e);
    }
  }

  async _selectCalendar(cal) {
    if (this._dirty && !confirm("Des modifications non sauvegardées seront perdues. Continuer ?")) return;
    this._selectedCalendar = cal;
    this._selectedEvent = null;
    this._dirty = false;
    this._renderCalendarList();
    this._renderEventList();
    this._renderEditor();

    try {
      this._shadow.querySelector(".event-list").innerHTML = '<div class="loading">Chargement…</div>';
      this._events = await callWS(this._hass, { type: "local_agenda/get_events", entry_id: cal.entry_id });
      this._renderEventList();
    } catch (e) { this._showToast("Erreur chargement événements : " + e, "error"); }
  }

  async _selectEvent(evt) {
    if (this._dirty && !confirm("Des modifications non sauvegardées seront perdues. Continuer ?")) return;
    this._selectedEvent = evt;
    this._dirty = false;
    this._renderEventList();

    try {
      const res = await callWS(this._hass, {
        type: "local_agenda/get_actions",
        entry_id: this._selectedCalendar.entry_id,
        uid: evt.uid,
      });
      this._currentActions = res.actions || {};
      this._renderEditor();
    } catch (e) {
      // The event may have been deleted since the list was last loaded
      const msg = String(e);
      if (msg.includes("not_found")) {
        this._showToast("Cet événement n'existe plus — rafraîchissement de la liste…", "error");
        this._selectedEvent = null;
        this._currentActions = {};
        this._renderEditor();
        await this._refreshEvents();
      } else {
        this._showToast("Erreur chargement actions : " + e, "error");
      }
    }
  }

  async _save() {
    const phases = this._shadow.querySelectorAll(".phase-block");
    for (const block of phases) {
      const err = block._laError ? block._laError() : null;
      if (err) { this._showToast(err, "error"); return; }
    }
    const actions = {};
    phases.forEach(block => {
      const data = readPhaseBlock(block);
      if (data !== null) actions[block.dataset.phase] = data;
    });

    try {
      await callWS(this._hass, {
        type: "local_agenda/set_actions",
        entry_id: this._selectedCalendar.entry_id,
        uid: this._selectedEvent.uid,
        actions,
      });
      this._currentActions = actions;
      this._dirty = false;
      const idx = this._events.findIndex(e => e.uid === this._selectedEvent.uid);
      if (idx !== -1) {
        this._events[idx].has_actions = Object.keys(actions).length > 0;
        this._renderEventList();
      }
      this._showToast("Actions sauvegardées ✓", "success");
    } catch (e) { this._showToast("Erreur de sauvegarde : " + e, "error"); }
  }

  // ---- Rendering ----

  _render() {
    this._shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="layout">
        <div class="sidebar">
          <div class="sidebar-header">📅 Local Agenda</div>
          <div class="cal-list"><div class="loading">Chargement…</div></div>
        </div>
        <div class="event-panel">
          <div class="panel-header">
            <span>Événements</span>
            <button class="btn-refresh" id="la-refresh-btn" title="Rafraîchir la liste">↺</button>
          </div>
          <div class="event-list"><div class="loading">Sélectionner un calendrier</div></div>
        </div>
        <div class="editor">
          <div class="editor-body">
            <div class="empty-state">
              <span style="font-size:48px">⚡</span>
              <span>Sélectionnez un événement pour configurer ses actions</span>
            </div>
          </div>
        </div>
      </div>
      <div class="toast" id="la-toast"></div>`;
  }

  _renderCalendarList() {
    const list = this._shadow.querySelector(".cal-list");
    list.innerHTML = "";
    if (!this._calendars.length) {
      list.innerHTML = '<div style="padding:16px;color:var(--secondary-text-color);font-size:13px;">Aucun calendrier</div>';
      return;
    }
    this._calendars.forEach(cal => {
      const item = document.createElement("div");
      item.className = "cal-item" + (this._selectedCalendar?.entry_id === cal.entry_id ? " active" : "");
      item.innerHTML = `<div class="cal-dot"></div><span>${cal.name}</span>`;
      item.onclick = () => this._selectCalendar(cal);
      list.appendChild(item);
    });
  }

  _renderEventList() {
    const list = this._shadow.querySelector(".event-list");
    list.innerHTML = "";
    if (!this._selectedCalendar) {
      list.innerHTML = '<div class="loading">Sélectionner un calendrier</div>';
      return;
    }
    if (!this._events.length) {
      list.innerHTML = '<div class="loading">Aucun événement</div>';
      return;
    }
    this._events.forEach(evt => {
      const item = document.createElement("div");
      item.className = "event-item" +
        (evt.has_actions ? " has-actions" : "") +
        (this._selectedEvent?.uid === evt.uid ? " active" : "");

      // Info zone (click = select event)
      const info = document.createElement("div");
      info.className = "event-item-info";
      info.innerHTML = `
        <div class="event-name">${evt.rrule ? "🔁 " : ""}${escHtml(evt.summary || "(sans titre)")}</div>
        <div class="event-meta">${(evt.start || "").substring(0, 10)}</div>`;
      info.onclick = () => this._selectEvent(evt);

      // Delete button (click = delete without selecting)
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-delete-event";
      delBtn.title = evt.rrule
        ? "Supprimer tous les évènements de cette série"
        : "Supprimer cet évènement";
      delBtn.textContent = "🗑";
      delBtn.onclick = (e) => { e.stopPropagation(); this._deleteEvent(evt); };

      item.append(info, delBtn);
      list.appendChild(item);
    });
  }

  async _deleteEvent(evt) {
    const isRecurring = !!evt.rrule;
    const name = evt.summary || "(sans titre)";
    const msg = isRecurring
      ? `Supprimer tous les évènements de la série « ${name} » ?\n(toutes les occurrences, passées et futures, seront supprimées)`
      : `Supprimer l'évènement « ${name} » ?`;

    if (!confirm(msg)) return;

    try {
      // 1. Supprimer la série entière (master + toutes les exceptions RECURRENCE-ID)
      await callWS(this._hass, {
        type: "local_agenda/delete_event",
        entry_id: this._selectedCalendar.entry_id,
        uid: evt.uid,
      });

      this._showToast(
        isRecurring ? "Série supprimée ✓" : "Évènement supprimé ✓",
        "success"
      );

      // Si l'événement supprimé était sélectionné, vider l'éditeur
      if (this._selectedEvent?.uid === evt.uid) {
        this._selectedEvent = null;
        this._currentActions = {};
        this._dirty = false;
        this._renderEditor();
      }

      // Rafraîchir la liste
      await this._refreshEvents();
    } catch (e) {
      this._showToast("Erreur lors de la suppression : " + e, "error");
    }
  }

  _renderEditor() {
    const editor = this._shadow.querySelector(".editor");
    editor.innerHTML = "";

    if (!this._selectedEvent) {
      editor.innerHTML = `<div class="editor-body"><div class="empty-state">
        <span style="font-size:48px">⚡</span>
        <span>Sélectionnez un événement pour configurer ses actions</span>
      </div></div>`;
      return;
    }

    // Header
    const hdr = document.createElement("div");
    hdr.className = "editor-header";
    hdr.innerHTML = `
      <div>
        <div class="editor-title">${this._selectedEvent.summary || "(sans titre)"}</div>
        <div style="font-size:13px;color:var(--secondary-text-color);margin-top:2px;">
          ${(this._selectedEvent.start || "").substring(0, 10)}
          ${this._selectedEvent.rrule ? " · 🔁 Récurrent" : ""}
        </div>
      </div>`;
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn-primary"; saveBtn.textContent = "💾 Sauvegarder";
    saveBtn.onclick = () => this._save();
    hdr.appendChild(saveBtn);

    // Body
    const body = document.createElement("div");
    body.className = "editor-body";
    body.addEventListener("input", () => { this._dirty = true; });
    body.addEventListener("change", () => { this._dirty = true; });

    // Info
    const info = document.createElement("div");
    info.style.cssText = "background:#e3f2fd;border-radius:6px;padding:12px 16px;font-size:13px;color:#1565c0;border:1px solid #90caf9;";
    info.innerHTML = "ℹ️  Tapez une partie du nom pour filtrer les services ou les entités. Les flèches ↑↓ et Entrée permettent de naviguer dans la liste.";

    const getStates = () => (this._hass && this._hass.states) || {};
    const startBlock = makePhaseBlock("on_start", this._currentActions.on_start || null, this._servicesMap, this._entityList, this._entityAttrs, getStates);
    const stopBlock  = makePhaseBlock("on_stop",  this._currentActions.on_stop  || null, this._servicesMap, this._entityList, this._entityAttrs, getStates);

    body.append(info, startBlock, stopBlock);
    editor.append(hdr, body);
  }

  _showToast(msg, type = "success") {
    const toast = this._shadow.getElementById("la-toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.className = `toast ${type} show`;
    setTimeout(() => { toast.className = "toast"; }, 3500);
  }
}

customElements.define("local-agenda-panel", LocalAgendaPanel);
