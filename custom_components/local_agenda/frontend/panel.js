// Local Agenda — Action Builder Panel
// Vanilla JS custom element, no build step required.
// Registered automatically by the integration via async_register_built_in_panel.

const VERSION = "1.3.0";

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
.cond-block-title { font-size: 13px; font-weight: 600; color: var(--secondary-text-color); margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; }
.cond-list { display: flex; flex-direction: column; gap: 8px; }
.cond-row { display: flex; align-items: center; gap: 8px; background: var(--card-background-color, #fff); border-radius: 4px; padding: 8px 10px; border: 1px solid var(--divider-color, #e0e0e0); }

/* Action rows */
.action-card { border: 1px solid var(--divider-color, #e0e0e0); border-radius: 6px; overflow: visible; margin-bottom: 4px; }
.action-card-header { padding: 10px 14px; background: var(--secondary-background-color, #f5f5f5); display: flex; align-items: center; gap: 10px; }
.action-number { font-size: 12px; font-weight: 700; color: var(--secondary-text-color); min-width: 20px; }
.action-card-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }

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
function makeFilterableInput({ placeholder = "", value = "", options = [], className = "", maxResults = 60, onSelect = null } = {}) {
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
  return { wrapper, input };
}

// ---------------------------------------------------------------------------
// Data row (key / value pair inside a service's data section)
// ---------------------------------------------------------------------------
function makeDataRow(key = "", value = "") {
  const row = document.createElement("div");
  row.className = "data-row";

  const kInput = document.createElement("input");
  kInput.type = "text"; kInput.placeholder = "clé"; kInput.value = key;
  kInput.className = "data-key";

  const vInput = document.createElement("input");
  vInput.type = "text"; vInput.placeholder = "valeur"; vInput.value = value;
  vInput.className = "data-value";

  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn-icon"; del.textContent = "✕"; del.title = "Supprimer";
  del.onclick = () => row.remove();

  row.append(kInput, vInput, del);
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
// Condition row
// ---------------------------------------------------------------------------
function makeCondRow(cond, entityList = []) {
  const row = document.createElement("div");
  row.className = "cond-row";

  const typeEl = document.createElement("select");
  typeEl.className = "cond-type-sel";
  typeEl.style.cssText = "width:110px;flex-shrink:0;";
  [{ v: "state", l: "État" }].forEach(({ v, l }) => {
    const o = document.createElement("option"); o.value = v; o.textContent = l;
    if (cond.condition === v) o.selected = true;
    typeEl.appendChild(o);
  });

  // Filterable entity input
  const { wrapper: entityWrapper, input: entityInput } = makeFilterableInput({
    placeholder: "entity_id",
    value: cond.entity_id || "",
    options: entityList,
    className: "cond-entity-input",
  });
  entityWrapper.style.flex = "1";

  const stateEl = document.createElement("input");
  stateEl.type = "text"; stateEl.placeholder = "état attendu"; stateEl.value = cond.state || "";
  stateEl.style.width = "120px"; stateEl.style.flexShrink = "0";

  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn-icon"; del.textContent = "✕";
  del.onclick = () => row.remove();

  row.append(typeEl, entityWrapper, stateEl, del);
  return row;
}

function readCondRow(row) {
  // entity input is inside .la-autocomplete wrapper — querySelector still reaches it
  const entityInput = row.querySelector(".cond-entity-input");
  const stateEl = row.querySelectorAll("input[type=text]");
  // stateEl[0] is entity (inside wrapper), stateEl[1] is the plain state input
  return {
    condition: row.querySelector(".cond-type-sel").value,
    entity_id: entityInput ? entityInput.value.trim() : (stateEl[0] ? stateEl[0].value.trim() : ""),
    state: stateEl[1] ? stateEl[1].value.trim() : "",
  };
}

// ---------------------------------------------------------------------------
// Action card
// ---------------------------------------------------------------------------
function makeActionCard(idx, actionData, servicesMap, entityList = []) {
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

  // Header
  const hdr = document.createElement("div");
  hdr.className = "action-card-header";
  const numSpan = document.createElement("span");
  numSpan.className = "action-number"; numSpan.textContent = `#${idx + 1}`;
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn-icon"; delBtn.textContent = "✕ Supprimer l'action";
  delBtn.style.marginLeft = "auto";
  delBtn.onclick = () => card.remove();
  hdr.append(numSpan, delBtn);

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

  // ---- Target entity_id (filterable) ----
  const targetLabel = document.createElement("label"); targetLabel.textContent = "Entité cible (target.entity_id)";
  const tgt = actionData.target || {};
  let targetVal = "";
  if (Array.isArray(tgt.entity_id)) targetVal = tgt.entity_id.join(", ");
  else if (tgt.entity_id) targetVal = tgt.entity_id;
  else if (actionData.entity_id) targetVal = actionData.entity_id;

  const { wrapper: targetWrapper, input: targetInput } = makeFilterableInput({
    placeholder: "light.salon  (ou plusieurs séparées par virgule)",
    value: targetVal,
    options: entityList,
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
  addDataBtn.onclick = () => dataContainer.appendChild(makeDataRow());
  dataTitleRow.appendChild(addDataBtn);

  const dataContainer = document.createElement("div");
  dataContainer.className = "data-container";

  // Pre-fill existing data fields
  const existingData = actionData.data || {};
  Object.entries(existingData).forEach(([k, v]) => {
    dataContainer.appendChild(makeDataRow(k, String(v)));
  });

  const dataHint = document.createElement("div");
  dataHint.className = "data-hint";
  dataHint.textContent = "Les champs connus du service apparaissent automatiquement lors de la sélection.";

  dataSection.append(dataTitleRow, dataContainer, dataHint);
  body.append(svcLabel, svcWrapper, targetLabel, targetWrapper, dataSection);

  // ---- Auto-suggest fields on service change ----
  function autoFillFields() {
    const svcFull = svcInput.value.trim();
    const dotIdx = svcFull.indexOf(".");
    if (dotIdx < 0) return;
    const domain = svcFull.substring(0, dotIdx);
    const svcName = svcFull.substring(dotIdx + 1);
    const svcDef = servicesMap && servicesMap[domain] && servicesMap[domain][svcName];
    if (!svcDef || !svcDef.fields) return;

    const existingKeys = new Set(
      Array.from(dataContainer.querySelectorAll(".data-key")).map(k => k.value.trim()).filter(Boolean)
    );

    Object.keys(svcDef.fields).forEach(field => {
      if (TARGET_FIELDS.has(field)) return;
      if (!existingKeys.has(field)) {
        dataContainer.appendChild(makeDataRow(field, ""));
        existingKeys.add(field);
      }
    });

    if (svcDef.description) {
      dataHint.textContent = svcDef.description;
    }
  }

  svcInput.addEventListener("change", autoFillFields);
  if (actionData.service && servicesMap) autoFillFields();

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
function makePhaseBlock(phase, phaseData, servicesMap, entityList = []) {
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
  condTitleRow.innerHTML = "<span>🔎 Conditions (toutes doivent être vraies)</span>";
  const addCondBtn = document.createElement("button");
  addCondBtn.type = "button";
  addCondBtn.className = "btn-add"; addCondBtn.textContent = "+ Condition";
  condTitleRow.appendChild(addCondBtn);
  const condList = document.createElement("div");
  condList.className = "cond-list";

  let existingConds = [];
  if (phaseData && typeof phaseData === "object" && !Array.isArray(phaseData)) {
    existingConds = phaseData.conditions || [];
  }
  existingConds.forEach(c => condList.appendChild(makeCondRow(c, entityList)));
  addCondBtn.onclick = () => condList.appendChild(makeCondRow({}, entityList));
  condBlock.append(condTitleRow, condList);

  // --- Actions ---
  const actionsContainer = document.createElement("div");
  actionsContainer.className = "actions-container";
  actionsContainer.style.cssText = "display:flex;flex-direction:column;gap:8px;";

  let existingActions = [];
  if (Array.isArray(phaseData)) existingActions = phaseData;
  else if (phaseData && typeof phaseData === "object") existingActions = phaseData.actions || [];

  existingActions.forEach((a, i) => {
    actionsContainer.appendChild(makeActionCard(i, a, servicesMap, entityList));
  });

  const actTitleRow = document.createElement("div");
  actTitleRow.style.cssText = "font-size:13px;font-weight:600;color:var(--secondary-text-color);display:flex;align-items:center;justify-content:space-between;margin-top:4px;";
  actTitleRow.innerHTML = "<span>⚡ Appels de service</span>";
  const addActionBtn = document.createElement("button");
  addActionBtn.type = "button";
  addActionBtn.className = "btn-add"; addActionBtn.textContent = "+ Ajouter un appel de service";
  addActionBtn.onclick = () => {
    const idx = actionsContainer.querySelectorAll(".action-card").length;
    actionsContainer.appendChild(makeActionCard(idx, {}, servicesMap, entityList));
  };
  actTitleRow.appendChild(addActionBtn);

  body.append(condBlock, actTitleRow, actionsContainer);
  block.append(hdr, body);
  return block;
}

function readPhaseBlock(block) {
  const condRows = block.querySelectorAll(".cond-list .cond-row");
  const conditions = Array.from(condRows).map(r => readCondRow(r)).filter(c => c.entity_id);

  const actionCards = block.querySelectorAll(".action-card");
  const actions = Array.from(actionCards).map(c => readActionCard(c)).filter(a => a.service);

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
    this._currentActions = {};
    this._dirty = false;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._init();
  }

  set panel(p) { this._panel = p; }

  async _init() {
    this._render();
    // Wire up the refresh button
    const refreshBtn = this._shadow.getElementById("la-refresh-btn");
    if (refreshBtn) refreshBtn.onclick = () => this._refreshEvents();
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

      // Entities from hass.states (always up to date)
      this._entityList = Object.keys(this._hass.states || {}).sort();
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

    const startBlock = makePhaseBlock("on_start", this._currentActions.on_start || null, this._servicesMap, this._entityList);
    const stopBlock  = makePhaseBlock("on_stop",  this._currentActions.on_stop  || null, this._servicesMap, this._entityList);

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
