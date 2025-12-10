// --- Core data structures -------------------------------------------------

const entities = new Map();

const globalStats = {
    totalLines: 0,
    parsedLines: 0,
    skippedLines: 0,
    byType: {
        DMG: 0,
        DOT: 0,
        HEAL: 0,
        ENERGIZE: 0,
        BUFF: 0,
        DEBUFF: 0
    }
};

// global time bounds across all parsed events
const timeBounds = {
    min: null,
    max: null
};

// current time filter
const timeFilter = {
    enabled: false,
    start: null,
    end: null
};

function getEntity(name) {
    if (!entities.has(name)) {
        entities.set(name, {
            name,

            // total (full log) – not used in filtered views, but kept
            damageDone: 0,
            healingDone: 0,
            damageReceived: 0,

            // detailed per-event data
            damageEvents: [],        // damage done by this entity
            healEvents: [],          // healing done by this entity
            damageTakenEvents: [],   // damage received by this entity
            buffsApplied: [],
            debuffsApplied: [],
            buffsReceived: [],
            debuffsReceived: []
        });
    }
    return entities.get(name);
}

function updateTimeBounds(timestamp) {
    if (timeBounds.min === null || timestamp < timeBounds.min) {
        timeBounds.min = timestamp;
    }
    if (timeBounds.max === null || timestamp > timeBounds.max) {
        timeBounds.max = timestamp;
    }
}

// --- Helpers --------------------------------------------------------------
function epochToLocalInput(ts) {
    const d = new Date(ts * 1000);
    // datetime-local wants YYYY-MM-DDTHH:MM
    return d.toISOString().slice(0, 16);
}

function localInputToEpoch(value) {
    // value format: "YYYY-MM-DDTHH:MM"
    const ms = Date.parse(value);
    return Math.floor(ms / 1000);
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function updateEntityDatalist() {
    const datalist = document.getElementById("entityList");
    if (!datalist) return;

    datalist.innerHTML = "";

    const names = Array.from(entities.keys()).sort((a, b) =>
        a.localeCompare(b)
    );

    for (const name of names) {
        const option = document.createElement("option");
        option.value = name;
        datalist.appendChild(option);
    }

    const hint = document.getElementById("entityDetailsHint");
    if (hint) {
        hint.textContent = names.length
            ? "Available entities: " + names.length
            : "No entities found in this log.";
    }
}

function buildEntityDamageBySkill(entity) {
    const map = new Map();
    for (const e of entity.damageEvents) {
        if (!isInCurrentTimeFrame(e.timestamp)) continue;
        const key = e.skill || "(no skill)";
        map.set(key, (map.get(key) || 0) + e.amount);
    }
    return map;
}

function buildEntityHealingBySkill(entity) {
    const map = new Map();
    for (const e of entity.healEvents) {
        if (!isInCurrentTimeFrame(e.timestamp)) continue;
        const key = e.skill || "(no skill)";
        map.set(key, (map.get(key) || 0) + e.amount);
    }
    return map;
}

function buildEntityTopDamageSources(entity, limit = 10) {
    const map = new Map();
    for (const e of entity.damageTakenEvents) {
        if (!isInCurrentTimeFrame(e.timestamp)) continue;
        const key = e.source || "(unknown)";
        map.set(key, (map.get(key) || 0) + e.amount);
    }

    const entries = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
    return entries.slice(0, limit);
}

function buildEntityAppliedBuffsByEffect(entity) {
    // key: type + "::" + effectName, value: count
    const map = new Map();

    for (const e of entity.buffsApplied) {
        if (!isInCurrentTimeFrame(e.timestamp)) continue;
        const key = "BUFF::" + (e.effectName || "(unknown)");
        map.set(key, (map.get(key) || 0) + 1);
    }

    for (const e of entity.debuffsApplied) {
        if (!isInCurrentTimeFrame(e.timestamp)) continue;
        const key = "DEBUFF::" + (e.effectName || "(unknown)");
        map.set(key, (map.get(key) || 0) + 1);
    }

    // return sorted array: [type, effectName, count]
    const result = [];
    for (const [key, count] of map.entries()) {
        const [type, name] = key.split("::");
        result.push({type, name, count});
    }

    result.sort((a, b) => b.count - a.count);
    return result;
}

function setInitialTimeFilterLast30Minutes() {
    if (timeBounds.min == null || timeBounds.max == null) return;

    // 30 minutes in seconds
    const THIRTY_MIN = 30 * 60;
    const candidateStart = timeBounds.max - THIRTY_MIN;

    // Clamp to earliest timestamp if the log is shorter than 30 minutes
    const start = Math.max(candidateStart, timeBounds.min);
    const end = timeBounds.max;

    timeFilter.enabled = true;
    timeFilter.start = start;
    timeFilter.end = end;

    const startInput = document.getElementById("timeStartISO");
    const endInput = document.getElementById("timeEndISO");
    const human = document.getElementById("timeHumanReadable");

    if (startInput && endInput) {
        startInput.value = epochToLocalInput(start);
        endInput.value = epochToLocalInput(end);
    }

    if (human) {
        human.textContent =
            "Current filter: last ~30 minutes (" +
            formatTimestamp(start) +
            " → " +
            formatTimestamp(end) +
            ")";
    }

    // Recompute stats for this window
    renderTables();
}


// --- Parsing logic --------------------------------------------------------

function parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    globalStats.totalLines++;

    const parts = trimmed.split(",").map(p => p.trim());
    if (parts.length < 2) {
        globalStats.skippedLines++;
        return;
    }

    const timestampStr = parts[0];
    const type = parts[1];

    const ts = Number(timestampStr);
    if (Number.isNaN(ts)) {
        globalStats.skippedLines++;
        return;
    }

    switch (type) {
        case "DMG":
        case "DOT":
        case "HEAL":
        case "ENERGIZE":
            parseNumericEvent(ts, type, parts);
            break;
        case "BUFF":
        case "DEBUFF":
            parseEffectEvent(ts, type, parts);
            break;
        default:
            globalStats.skippedLines++;
    }
}

function parseNumericEvent(timestamp, type, parts) {
    if (parts.length < 8) {
        globalStats.skippedLines++;
        return;
    }

    const sourceName = parts[2];
    const targetName = parts[3];
    const skill = parts[4];
    const amountStr = parts[5];
    const pool = parts[6];
    const hitType = parts[7];

    const amountRaw = Number(amountStr);
    if (Number.isNaN(amountRaw)) {
        globalStats.skippedLines++;
        return;
    }

    globalStats.parsedLines++;
    globalStats.byType[type] = (globalStats.byType[type] || 0) + 1;
    updateTimeBounds(timestamp);

    const source = getEntity(sourceName);
    const target = getEntity(targetName);

    if (type === "DMG" || type === "DOT") {
        const dmgAmount = amountRaw < 0 ? -amountRaw : amountRaw;

        source.damageDone += dmgAmount;
        target.damageReceived += dmgAmount;

        const dmgEvent = {
            timestamp,
            type,
            target: targetName,
            skill,
            amount: dmgAmount,
            pool,
            hitType
        };

        const dmgTakenEvent = {
            timestamp,
            type,
            source: sourceName,
            skill,
            amount: dmgAmount,
            pool,
            hitType
        };

        source.damageEvents.push(dmgEvent);
        target.damageTakenEvents.push(dmgTakenEvent);
    } else if (type === "HEAL") {
        const healAmount = Math.abs(amountRaw);

        source.healingDone += healAmount;

        const healEvent = {
            timestamp,
            type,
            target: targetName,
            skill,
            amount: healAmount,
            pool,
            hitType
        };

        source.healEvents.push(healEvent);
    } else if (type === "ENERGIZE") {
        const regenEvent = {
            timestamp,
            type,
            source: sourceName,
            target: targetName,
            skill,
            amount: amountRaw,
            pool,
            hitType
        };
        // Not yet aggregated, but kept if you want mana stats later
        // e.g. source.energizeEvents.push(regenEvent)
    }
}

function parseEffectEvent(timestamp, type, parts) {
    if (parts.length < 6) {
        globalStats.skippedLines++;
        return;
    }

    const sourceName = parts[2];
    const targetName = parts[3];
    const effectName = parts[4];
    const effectIdStr = parts[5];
    const effectId = Number(effectIdStr);

    globalStats.parsedLines++;
    globalStats.byType[type] = (globalStats.byType[type] || 0) + 1;
    updateTimeBounds(timestamp);

    const source = getEntity(sourceName);
    const target = getEntity(targetName);

    const effectEvent = {
        timestamp,
        type,
        source: sourceName,
        target: targetName,
        effectName,
        effectId: Number.isNaN(effectId) ? effectIdStr : effectId
    };

    if (type === "BUFF") {
        source.buffsApplied.push(effectEvent);
        target.buffsReceived.push(effectEvent);
    } else {
        source.debuffsApplied.push(effectEvent);
        target.debuffsReceived.push(effectEvent);
    }
}

// --- Aggregation for current time frame -----------------------------------

function isInCurrentTimeFrame(timestamp) {
    if (!timeFilter.enabled) return true;
    return timestamp >= timeFilter.start && timestamp <= timeFilter.end;
}

/**
 * Build a list of entities with damageDone/healingDone/damageReceived
 * aggregated over the current time frame only.
 */
function buildAggregatedEntitiesForCurrentTimeFrame() {
    const result = [];

    for (const entity of entities.values()) {
        let damageDone = 0;
        let healingDone = 0;
        let damageReceived = 0;

        for (const e of entity.damageEvents) {
            if (isInCurrentTimeFrame(e.timestamp)) {
                damageDone += e.amount;
            }
        }

        for (const e of entity.healEvents) {
            if (isInCurrentTimeFrame(e.timestamp)) {
                healingDone += e.amount;
            }
        }

        for (const e of entity.damageTakenEvents) {
            if (isInCurrentTimeFrame(e.timestamp)) {
                damageReceived += e.amount;
            }
        }

        result.push({
            name: entity.name,
            damageDone,
            healingDone,
            damageReceived
        });
    }

    return result;
}

// --- Rendering ------------------------------------------------------------

function renderTables() {
    const aggregated = buildAggregatedEntitiesForCurrentTimeFrame();

    const byDamageDone = [...aggregated].sort((a, b) => b.damageDone - a.damageDone);
    const byHealingDone = [...aggregated].sort((a, b) => b.healingDone - a.healingDone);
    const byDamageReceived = [...aggregated].sort((a, b) => b.damageReceived - a.damageReceived);

    renderEntityTable(
        "damageDoneTableContainer",
        byDamageDone,
        "damageDone",
        "Damage Done",
        true   // include %
    );

    renderEntityTable(
        "healingDoneTableContainer",
        byHealingDone,
        "healingDone",
        "Healing Done",
        true   // include %
    );

    renderEntityTable(
        "damageReceivedTableContainer",
        byDamageReceived,
        "damageReceived",
        "Damage Received",
        false  // no %
    );
}

/**
 * Renders a table of entities.
 * - Filters out rows where row[valueField] <= 0
 * - Adds rank column
 * - Optionally adds "% of total" column
 */
function renderEntityTable(containerId, rows, valueField, valueLabel, includePercent) {
    const container = document.getElementById(containerId);

    const filteredRows = rows.filter(row => {
        const v = row[valueField];
        return typeof v === "number" && v > 0;
    });

    if (!filteredRows.length) {
        container.innerHTML = "<p>No data.</p>";
        return;
    }

    const total = filteredRows.reduce((sum, row) => sum + row[valueField], 0);

    let html = "<table><thead><tr>";
    html += "<th>#</th>";
    html += "<th>Entity</th>";
    html += "<th>" + valueLabel + "</th>";
    if (includePercent) {
        html += "<th>% of total</th>";
    }
    html += "</tr></thead><tbody>";

    filteredRows.forEach((row, index) => {
        const amount = row[valueField];
        const rank = index + 1;
        const amountFormatted =
            typeof amount === "number" ? amount.toLocaleString() : amount;

        html += "<tr>";

        // Rank
        html += "<td>" + rank + "</td>";

        // CLICKABLE entity name
        const safeName = escapeHtml(row.name);
        html +=
            `<td class="summary-entity" data-entity="${safeName}">${safeName}</td>`;

        // Amount
        html += "<td>" + amountFormatted + "</td>";

        // Percent (if enabled)
        if (includePercent) {
            const pct = total > 0 ? (amount / total) * 100 : 0;
            const pctFormatted = pct.toFixed(1) + "%";
            html += "<td>" + pctFormatted + "</td>";
        }

        html += "</tr>";
    });

    html += "</tbody></table>";
    container.innerHTML = html;
}

function renderSummary(fileName) {
    const el = document.getElementById("logSummary");

    const parts = [];
    parts.push("File: " + (fileName || "n/a"));
    parts.push("Total lines: " + globalStats.totalLines);
    parts.push("Parsed: " + globalStats.parsedLines);
    parts.push("Skipped: " + globalStats.skippedLines);

    const typeCounts = [];
    for (const [type, count] of Object.entries(globalStats.byType)) {
        if (count > 0) {
            typeCounts.push(type + ": " + count);
        }
    }

    if (typeCounts.length) {
        parts.push("By type: " + typeCounts.join(", "));
    }

    el.textContent = parts.join(" | ");
}

function renderDebug() {
    const debugButton = document.getElementById("debugToggle");
    const debugOutput = document.getElementById("debugOutput");

    const snapshot = {
        globalStats,
        timeBounds,
        timeFilter,
        entities: Object.fromEntries(
            Array.from(entities.entries()).map(([name, data]) => [name, data])
        )
    };

    debugOutput.textContent = JSON.stringify(snapshot, null, 2);
    debugButton.classList.remove("hidden");
}

// --- Time filter UI -------------------------------------------------------

function formatTimestamp(ts) {
    if (ts == null) return "n/a";
    const d = new Date(ts * 1000);
    return d.toLocaleString();
}

function setupTimeFilterUI() {
    const info = document.getElementById("timeBoundsInfo");
    const human = document.getElementById("timeHumanReadable");
    const startInput = document.getElementById("timeStartISO");
    const endInput = document.getElementById("timeEndISO");

    if (timeBounds.min == null || timeBounds.max == null) {
        info.textContent = "No timestamped events found.";
        human.textContent = "";
        return;
    }

    // default filter = full range
    timeFilter.enabled = false;
    timeFilter.start = timeBounds.min;
    timeFilter.end = timeBounds.max;

    startInput.value = epochToLocalInput(timeBounds.min);
    endInput.value = epochToLocalInput(timeBounds.max);

    info.textContent =
        "Earliest: " + formatTimestamp(timeBounds.min) +
        " | Latest: " + formatTimestamp(timeBounds.max);

    human.textContent = "Current filter: full range (" +
        formatTimestamp(timeBounds.min) +
        " → " +
        formatTimestamp(timeBounds.max) +
        ")";
}

function applyTimeFilterFromInputs() {
    const startInput = document.getElementById("timeStartISO");
    const endInput = document.getElementById("timeEndISO");
    const human = document.getElementById("timeHumanReadable");

    const startEpoch = localInputToEpoch(startInput.value);
    const endEpoch = localInputToEpoch(endInput.value);

    if (Number.isNaN(startEpoch) || Number.isNaN(endEpoch)) {
        alert("Invalid date format.");
        return;
    }

    if (startEpoch < timeBounds.min || startEpoch > timeBounds.max ||
        endEpoch < timeBounds.min || endEpoch > timeBounds.max) {
        alert("Time must be within earliest/latest log timestamps.");
        return;
    }

    if (startEpoch > endEpoch) {
        alert("Start time must be before end time.");
        return;
    }

    timeFilter.enabled = true;
    timeFilter.start = startEpoch;
    timeFilter.end = endEpoch;

    human.textContent =
        "Current filter: " +
        formatTimestamp(startEpoch) +
        " → " +
        formatTimestamp(endEpoch);

    renderTables();
}


function resetTimeFilterToFullRange() {
    const startInput = document.getElementById("timeStartISO");
    const endInput = document.getElementById("timeEndISO");
    const human = document.getElementById("timeHumanReadable");

    timeFilter.enabled = false;
    timeFilter.start = timeBounds.min;
    timeFilter.end = timeBounds.max;

    startInput.value = epochToLocalInput(timeBounds.min);
    endInput.value = epochToLocalInput(timeBounds.max);

    human.textContent =
        "Current filter: full range (" +
        formatTimestamp(timeBounds.min) +
        " → " +
        formatTimestamp(timeBounds.max) +
        ")";

    renderTables();
}

function renderEntityDetails(entityName) {
    const container = document.getElementById("entityDetailsContainer");
    const hint = document.getElementById("entityDetailsHint");

    if (!entityName) {
        if (hint) hint.textContent = "Please type an entity name and press Show.";
        if (container) container.innerHTML = "";
        return;
    }

    const entity = entities.get(entityName);
    if (!entity) {
        if (hint) hint.textContent = "Entity not found: " + entityName;
        if (container) container.innerHTML = "";
        return;
    }

    // Aggregates (time-filtered)
    const dmgBySkill = buildEntityDamageBySkill(entity);
    const healBySkill = buildEntityHealingBySkill(entity);
    const topDamageSources = buildEntityTopDamageSources(entity);
    const appliedEffects = buildEntityAppliedBuffsByEffect(entity);

    // Split buffs vs debuffs
    const appliedBuffs = appliedEffects.filter(r => r.type === "BUFF");
    const appliedDebuffs = appliedEffects.filter(r => r.type === "DEBUFF");

    // Totals for %
    const totalDmg = Array.from(dmgBySkill.values()).reduce((a, b) => a + b, 0);
    const totalHeal = Array.from(healBySkill.values()).reduce((a, b) => a + b, 0);
    const totalTaken = topDamageSources.reduce((sum, [, v]) => sum + v, 0);

    let html = `<div class="entity-details-header">
    <strong>${entityName}</strong>
  </div>`;

    // Wrapper: 3 flex columns now
    html += `<div class="entity-details-grid">
    <div class="entity-details-column">`;

    // COLUMN 1, SECTION 1 — Damage by skill (RED)
    html += `<div class="entity-subsection entity-subsection--dmg">
    <h3>Damage (by skill)</h3>`;

    if (!dmgBySkill.size) {
        html += `<p><small>No damage done.</small></p>`;
    } else {
        html += `<table class="entity-metric-table"><thead><tr>
      <th>Skill</th><th>Damage</th><th>%</th>
    </tr></thead><tbody>`;
        for (const [skill, amount] of [...dmgBySkill.entries()].sort((a, b) => b[1] - a[1])) {
            const pct = totalDmg ? (amount / totalDmg) * 100 : 0;
            html += `<tr>
        <td>${skill}</td>
        <td>${amount.toLocaleString()}</td>
        <td>${pct.toFixed(1)}%</td>
      </tr>`;
        }
        html += `</tbody></table>`;
    }

    html += `</div>`; // end col1 section1

    // COLUMN 1, SECTION 2 — Healing by skill (GREEN)
    html += `<div class="entity-subsection entity-subsection--heal">
    <h3>Healing (by skill)</h3>`;

    if (!healBySkill.size) {
        html += `<p><small>No healing done.</small></p>`;
    } else {
        html += `<table class="entity-metric-table"><thead><tr>
      <th>Skill</th><th>Healing</th><th>%</th>
    </tr></thead><tbody>`;
        for (const [skill, amount] of [...healBySkill.entries()].sort((a, b) => b[1] - a[1])) {
            const pct = totalHeal ? (amount / totalHeal) * 100 : 0;
            html += `<tr>
        <td>${skill}</td>
        <td>${amount.toLocaleString()}</td>
        <td>${pct.toFixed(1)}%</td>
      </tr>`;
        }
        html += `</tbody></table>`;
    }

    html += `</div>`; // end col1 section2

    // COLUMN 1, SECTION 3 — Damage received by source (BLUE)
    html += `<div class="entity-subsection entity-subsection--tank">
    <h3>Damage received (by attacker)</h3>`;

    if (!topDamageSources.length) {
        html += `<p><small>No damage taken.</small></p>`;
    } else {
        html += `<table class="entity-metric-table"><thead><tr>
      <th>Source</th><th>Damage</th><th>%</th>
    </tr></thead><tbody>`;
        for (const [source, amount] of topDamageSources) {
            const pct = totalTaken ? (amount / totalTaken) * 100 : 0;
            html += `<tr>
        <td>${source}</td>
        <td>${amount.toLocaleString()}</td>
        <td>${pct.toFixed(1)}%</td>
      </tr>`;
        }
        html += `</tbody></table>`;
    }

    html += `</div>`; // end col1 section3

    // Close column 1, open column 2 (BUFFS)
    html += `</div><div class="entity-details-column">`;

    // COLUMN 2 — Buffs applied (YELLOW)
    html += `<div class="entity-subsection entity-subsection--buff">
    <h3>Buffs applied by ${entityName}</h3>`;

    if (!appliedBuffs.length) {
        html += `<p><small>No buffs applied.</small></p>`;
    } else {
        html += `<table><thead><tr>
      <th>Effect</th><th>Count</th>
    </tr></thead><tbody>`;
        for (const row of appliedBuffs) {
            html += `<tr>
        <td>${row.name}</td>
        <td>${row.count}</td>
      </tr>`;
        }
        html += `</tbody></table>`;
    }

    html += `</div>`; // end column 2

    // Close column 2, open column 3 (DEBUFFS)
    html += `</div><div class="entity-details-column">`;

    // COLUMN 3 — Debuffs applied (YELLOW)
    html += `<div class="entity-subsection entity-subsection--buff">
    <h3>Debuffs applied by ${entityName}</h3>`;

    if (!appliedDebuffs.length) {
        html += `<p><small>No debuffs applied.</small></p>`;
    } else {
        html += `<table><thead><tr>
      <th>Effect</th><th>Count</th>
    </tr></thead><tbody>`;
        for (const row of appliedDebuffs) {
            html += `<tr>
        <td>${row.name}</td>
        <td>${row.count}</td>
      </tr>`;
        }
        html += `</tbody></table>`;
    }

    html += `</div>`; // end column 3 subsection

    html += `</div></div>`; // close column 3 + grid

    container.innerHTML = html;

    if (hint) {
        const fromTs = timeFilter.start ?? timeBounds.min;
        const toTs = timeFilter.end ?? timeBounds.max;
        hint.textContent =
            `Showing stats for "${entityName}" in current time frame (${formatTimestamp(fromTs)} → ${formatTimestamp(toTs)})`;
    }
}

// --- File handling / wiring -------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
    const parseButton = document.getElementById("parseButton");
    const debugToggle = document.getElementById("debugToggle");
    const applyTimeButton = document.getElementById("applyTimeFilter");
    const resetTimeButton = document.getElementById("resetTimeFilter");

    const summaryToggleBtn = document.getElementById("summaryCollapseToggle");
    const summaryBody = document.getElementById("summaryBody");
    const summaryIcon = document.getElementById("summaryToggleIcon");

    const entityInput = document.getElementById("entityInput");
    const showEntityDetailsBtn = document.getElementById("showEntityDetails");

    const entityDetailsToggle = document.getElementById("entityDetailsToggle");
    const entityDetailsBody = document.getElementById("entityDetailsBody");
    const entityToggleIcon = document.getElementById("entityToggleIcon");

    parseButton.addEventListener("click", () => {
        const input = document.getElementById("logFileInput");
        if (!input.files || !input.files.length) {
            alert("Please select a log file first.");
            return;
        }

        const file = input.files[0];

        // reset state
        entities.clear();
        globalStats.totalLines = 0;
        globalStats.parsedLines = 0;
        globalStats.skippedLines = 0;
        for (const key of Object.keys(globalStats.byType)) {
            globalStats.byType[key] = 0;
        }
        timeBounds.min = null;
        timeBounds.max = null;
        timeFilter.enabled = false;
        timeFilter.start = null;
        timeFilter.end = null;

        document.getElementById("damageDoneTableContainer").innerHTML = "";
        document.getElementById("healingDoneTableContainer").innerHTML = "";
        document.getElementById("damageReceivedTableContainer").innerHTML = "";
        document.getElementById("debugOutput").classList.add("hidden");
        document.getElementById("timeBoundsInfo").textContent = "";
        document.getElementById("timeHumanReadable").textContent = "";

        const reader = new FileReader();
        reader.onload = () => {
            const text = reader.result;
            const lines = text.split(/\r?\n/);

            for (const line of lines) {
                parseLine(line);
            }

            // Show bounds and wire inputs
            setupTimeFilterUI();

            // Default window: last 30 minutes of the log
            setInitialTimeFilterLast30Minutes();

            renderSummary(file.name);
            renderDebug();
            updateEntityDatalist();
            renderEntityDetails("");

            // Make sure entity details are visible after new log load
            entityDetailsBody.classList.remove("collapsed");
            entityToggleIcon.textContent = "▼";
        };
        reader.readAsText(file);
    });

    debugToggle.addEventListener("click", () => {
        const debugOutput = document.getElementById("debugOutput");
        debugOutput.classList.toggle("hidden");
    });

    applyTimeButton.addEventListener("click", applyTimeFilterFromInputs);
    resetTimeButton.addEventListener("click", resetTimeFilterToFullRange);

    // Collapsible summary toggle
    summaryToggleBtn.addEventListener("click", () => {
        const isCollapsed = summaryBody.classList.toggle("collapsed");
        summaryIcon.textContent = isCollapsed ? "▶" : "▼";
    });

    // Collapsible entity details toggle
    entityDetailsToggle.addEventListener("click", () => {
        const collapsed = entityDetailsBody.classList.toggle("collapsed");
        entityToggleIcon.textContent = collapsed ? "▶" : "▼";
    });

    showEntityDetailsBtn.addEventListener("click", () => {
        const name = entityInput.value.trim();
        renderEntityDetails(name);
    });

    entityInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const name = entityInput.value.trim();
            renderEntityDetails(name);
        }
    });

    const damageDoneContainer = document.getElementById("damageDoneTableContainer");
    const healingDoneContainer = document.getElementById("healingDoneTableContainer");
    const damageReceivedContainer = document.getElementById("damageReceivedTableContainer");

    function handleSummaryClick(e) {
        const cell = e.target.closest(".summary-entity");
        if (!cell) return;

        const name = cell.dataset.entity;
        if (!name) return;

        const entityInput = document.getElementById("entityInput");
        const entityDetailsBody = document.getElementById("entityDetailsBody");
        const entityToggleIcon = document.getElementById("entityToggleIcon");

        // Fill input
        if (entityInput) {
            entityInput.value = name;
        }

        // Ensure details section is open
        if (entityDetailsBody && entityToggleIcon) {
            entityDetailsBody.style.display = "";
            entityToggleIcon.textContent = "▼";
        }

        // Render details
        renderEntityDetails(name);
    }

    damageDoneContainer.addEventListener("click", handleSummaryClick);
    healingDoneContainer.addEventListener("click", handleSummaryClick);
    damageReceivedContainer.addEventListener("click", handleSummaryClick);
});