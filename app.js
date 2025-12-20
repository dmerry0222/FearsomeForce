/* ============================================================================
   D&D Scheduler — app.js (Supabase REST)
   Matches schemas:
     public.availability(group_id, person_id, date, status, updated_at) PK(group_id, person_id, date)
     public.decisions(group_id, date, is_blocked, is_confirmed, time_text, updated_at) PK(group_id, date)
   ============================================================================ */

/*** 1) CONFIG — PASTE YOUR SUPABASE VALUES HERE ********************************/
const SUPABASE_URL = "https://oafvjbtxcymogqnledns.supabase.co"; // <-- your Supabase project URL
const SUPABASE_ANON_KEY =
  "PASTE_YOUR_SUPABASE_ANON_KEY_HERE"; // <-- your anon public API key (JWT)

/*** 2) APP CONFIG **************************************************************/
const GROUP_ID = "fearsomeforce";

const PEOPLE = [
  { id: "dandon", name: "Dandon", color: "#8C0A0A" },
  { id: "jassa", name: "Jassa", color: "#4D1B5B" },
  { id: "laurel", name: "Laurel", color: "#156D45" },
  { id: "lia", name: "Lia", color: "#0F4116" },
  { id: "lilli", name: "Lilli", color: "#DB0B91" },
  { id: "silas", name: "Silas", color: "#A47D00" },
];

const STATUS_COLORS = {
  available: "#22c55e",
  virtual: "#3b82f6",
  maybe: "#f59e0b",
  unavailable: "#ef4444",
};

const SCORE = {
  available: 3,
  virtual: 2,
  maybe: 1,
  unknown: 0,
  unavailable: -3,
};

const WEIGHED_IN_MIN_FOR_BEST = 4;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/*** 3) DOM HOOKS **************************************************************/
const $ = (sel) => document.querySelector(sel);
const el = {
  banner: $("#banner"),
  bannerTitle: $("#bannerTitle"),
  selectedPill: $("#selectedPill"),
  selectedCount: $("#selectedCount"),
  clearSelectedX: $("#clearSelectedX"),
  changeChar: $("#changeChar"),

  modeMy: $("#modeMy"),
  modeGroup: $("#modeGroup"),

  monthLabel: $("#monthLabel"),
  prev: $("#prev"),
  next: $("#next"),

  grid: $("#grid"),

  actions: $("#actions"),
  btnAvail: $("#avail"),
  btnVirt: $("#virt"),
  btnMaybe: $("#maybe"),
  btnUnavail: $("#unavail"),
  btnClearStatus: $("#clearStatus"),

  modalPick: $("#modalPickChar"),
  charGrid: $("#charGrid"),

  loadingOverlay: $("#loadingOverlay"),
  loadingText: $("#loadingText"),

  groupDetailModal: $("#groupDetailModal"),
  groupDetailTitle: $("#groupDetailTitle"),
  groupDetailList: $("#groupDetailList"),
  groupDetailClose: $("#groupDetailClose"),
  btnBlockDate: $("#btnBlockDate"),
  btnUnblockDate: $("#btnUnblockDate"),
  btnConfirmDate: $("#btnConfirmDate"),
  btnCancelConfirm: $("#btnCancelConfirm"),
  btnEditTime: $("#btnEditTime"),

  timeModal: $("#timeModal"),
  timeModalTitle: $("#timeModalTitle"),
  timeModalSub: $("#timeModalSub"),
  timeInput: $("#timeInput"),
  timeSave: $("#timeSave"),
  timeClose: $("#timeClose"),

  toast: $("#toast"),
  toastText: $("#toastText"),
};

function assertConfig() {
  if (!SUPABASE_URL || SUPABASE_URL.includes("PASTE_")) {
    alert("Set SUPABASE_URL at the top of app.js");
    throw new Error("SUPABASE_URL not set");
  }
  if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes("PASTE_")) {
    alert("Set SUPABASE_ANON_KEY at the top of app.js");
    throw new Error("SUPABASE_ANON_KEY not set");
  }
}

/*** 4) STATE ******************************************************************/
let mode = localStorage.getItem("mode") || "my"; // "my" | "group"
let currentChar = localStorage.getItem("char") || "";
let selected = new Set(); // YYYY-MM-DD strings (my view selection)

// currentMonth is set during init from URL (step 1/2 below), defaulting to current month.
let currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

let availabilityMap = Object.create(null); // { [dateKey]: { [person_id]: status } }
let myStatusMap = Object.create(null); // { [dateKey]: status }
let decisionsMap = Object.create(null); // { [dateKey]: {is_blocked,is_confirmed,time_text} }

let pendingWrites = 0;
let activeGroupDateKey = null;

// Which date are we editing time_text for?
let timeModalTargetDateKey = null;

/*** 5) UTIL *******************************************************************/
const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function monthStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function monthEndExclusive(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}
function parseYMD(s) {
  const [y, m, dd] = s.split("-").map(Number);
  return new Date(y, m - 1, dd);
}
function dateTitleShort(dateKey) {
  const d = parseYMD(dateKey);
  return `${DOW[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}
function showToast(msg, ms = 1800) {
  if (!el.toast || !el.toastText) return;
  el.toastText.textContent = msg;
  el.toast.style.display = "flex";
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (el.toast.style.display = "none"), ms);
}
function setLoading(on, text = "Loading…") {
  if (!el.loadingOverlay) return;
  if (el.loadingText) el.loadingText.textContent = text;
  el.loadingOverlay.style.display = on ? "flex" : "none";
}

/*** 5.1) URL MONTH ROUTING (Steps 1, 2, 3) ************************************/
/**
 * Step 1: Read /MM_YYYY from the URL path (e.g., /DnDScheduler/02_2026)
 * Returns a Date(year, month-1, 1) or null.
 */
function getMonthFromURL() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  const match = last && last.match(/^(\d{2})_(\d{4})$/);
  if (!match) return null;

  const mm = parseInt(match[1], 10);
  const yyyy = parseInt(match[2], 10);
  if (!(mm >= 1 && mm <= 12) || !(yyyy >= 1900 && yyyy <= 3000)) return null;

  return new Date(yyyy, mm - 1, 1);
}

/**
 * Step 3: Update the URL when the month changes (keeps links shareable/bookmarkable).
 * Uses history.replaceState so it doesn't spam the back button.
 *
 * Works for both cases:
 * - URL already ends in /MM_YYYY  -> replace that segment
 * - URL ends in /DnDScheduler/    -> append /MM_YYYY
 */
function updateURLForMonth(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  const seg = `${mm}_${yyyy}`;

  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length === 0) return;

  const last = parts[parts.length - 1];
  const baseParts = last.match(/^(\d{2})_(\d{4})$/) ? parts.slice(0, -1) : parts;

  const newPath = "/" + [...baseParts, seg].join("/") + "/";
  window.history.replaceState({}, "", newPath);
}

/*** 6) SUPABASE REST **********************************************************/
async function sbFetch(path, { method = "GET", headers = {}, body = null } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : null,
  });

  if (!res.ok) {
    let errText = "";
    try {
      errText = await res.text();
    } catch {}
    throw new Error(`Supabase ${res.status} ${res.statusText}: ${errText}`);
  }

  if (res.status === 204) return null;

  const text = await res.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isoDate(d) {
  return typeof d === "string" ? d : ymd(d);
}

/*** 7) LOAD MONTH **************************************************************/
async function loadMonthData() {
  if (!currentChar && mode === "my") return;

  const start = isoDate(monthStart(currentMonth));
  const end = isoDate(monthEndExclusive(currentMonth));

  // decisions
  const decisions = await sbFetch(
    `decisions?select=group_id,date,is_blocked,is_confirmed,time_text&group_id=eq.${encodeURIComponent(
      GROUP_ID
    )}&date=gte.${start}&date=lt.${end}`
  );

  decisionsMap = Object.create(null);
  for (const row of decisions || []) {
    const key = row.date;
    decisionsMap[key] = {
      is_blocked: !!row.is_blocked,
      is_confirmed: !!row.is_confirmed,
      time_text: row.time_text ?? "",
    };
  }

  // availability
  const avail = await sbFetch(
    `availability?select=group_id,person_id,date,status&group_id=eq.${encodeURIComponent(
      GROUP_ID
    )}&date=gte.${start}&date=lt.${end}`
  );

  availabilityMap = Object.create(null);
  myStatusMap = Object.create(null);

  for (const row of avail || []) {
    const key = row.date;
    if (!availabilityMap[key]) availabilityMap[key] = Object.create(null);
    availabilityMap[key][row.person_id] = (row.status || "").toLowerCase();

    if (row.person_id === currentChar) {
      myStatusMap[key] = (row.status || "").toLowerCase();
    }
  }
}

/*** 8) RENDER ******************************************************************/
function renderBanner() {
  if (!el.bannerTitle) return;

  if (mode === "group") {
    el.bannerTitle.textContent = "Group Availability";
    if (el.banner) {
      el.banner.style.background = "#111827";
      el.banner.style.borderColor = "rgba(255,255,255,.14)";
    }
    if (el.changeChar) el.changeChar.style.display = "none";
    if (el.selectedPill) el.selectedPill.style.display = "none";
    return;
  }

  const c = PEOPLE.find((p) => p.id === currentChar);
  el.bannerTitle.textContent = c ? `${c.name}'s Availability` : "Pick a character";

  if (el.banner && c) {
    el.banner.style.background = c.color;
    el.banner.style.borderColor = "rgba(255,255,255,.18)";
  }
  if (el.changeChar) el.changeChar.style.display = "inline-flex";
  if (el.selectedPill) el.selectedPill.style.display = "inline-flex";
}

function renderModeButtons() {
  if (el.modeMy) el.modeMy.classList.toggle("active", mode === "my");
  if (el.modeGroup) el.modeGroup.classList.toggle("active", mode === "group");
}

function renderMonthLabel() {
  if (!el.monthLabel) return;
  const d = currentMonth;
  el.monthLabel.textContent = `${d.toLocaleString(undefined, { month: "long" })} ${d.getFullYear()}`;
}

function decisionFor(dateKey) {
  return decisionsMap[dateKey] || { is_blocked: false, is_confirmed: false, time_text: "" };
}

function getConfirmedDateKeyForThisMonth() {
  const start = monthStart(currentMonth);
  const end = monthEndExclusive(currentMonth);
  for (const [k, v] of Object.entries(decisionsMap)) {
    const d = parseYMD(k);
    if (d >= start && d < end && v.is_confirmed) return k;
  }
  return null;
}

function computeBestDatesForThisMonth() {
  const first = monthStart(currentMonth);
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();

  let bestScore = -Infinity;
  let bestKeys = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(first.getFullYear(), first.getMonth(), day);
    const key = ymd(d);

    const per = availabilityMap[key] || {};
    let weighedIn = 0;
    let score = 0;

    for (const person of PEOPLE) {
      const st = per[person.id];
      if (!st) continue;
      weighedIn++;
      score += SCORE[st] ?? 0;
    }

    if (weighedIn < WEIGHED_IN_MIN_FOR_BEST) continue;

    if (score > bestScore) {
      bestScore = score;
      bestKeys = [key];
    } else if (score === bestScore) {
      bestKeys.push(key);
    }
  }

  return new Set(bestKeys);
}

function renderCalendar() {
  if (!el.grid) return;

  el.grid.innerHTML = "";

  const first = monthStart(currentMonth);
  const firstDow = first.getDay();
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();

  const bestKeys = mode === "group" ? computeBestDatesForThisMonth() : new Set();
  const confirmedKeyThisMonth = getConfirmedDateKeyForThisMonth();

  for (let i = 0; i < 42; i++) {
    const dayNum = i - firstDow + 1;

    const cell = document.createElement("div");
    cell.className = "cell";

    if (dayNum < 1 || dayNum > daysInMonth) {
      cell.classList.add("blank");
      el.grid.appendChild(cell);
      continue;
    }

    const dateObj = new Date(first.getFullYear(), first.getMonth(), dayNum);
    const key = ymd(dateObj);

    const dec = decisionFor(key);

    if (dec.is_blocked) cell.classList.add("blocked");
    if (bestKeys.has(key)) cell.classList.add("best");
    if (key === confirmedKeyThisMonth) cell.classList.add("confirmed");

    if (mode === "my" && selected.has(key)) cell.classList.add("selected");

    if (mode === "group") {
      cell.classList.add("groupcell");

      const topRow = document.createElement("div");
      topRow.className = "groupcell-top";

      const num = document.createElement("div");
      num.className = "num";
      num.textContent = String(dayNum);
      if (dec.is_blocked) num.classList.add("num-blocked");
      topRow.appendChild(num);

      const dots = document.createElement("div");
      dots.className = "dotgrid";

      const per = availabilityMap[key] || {};
      for (const person of PEOPLE) {
        const st = per[person.id] || "";
        const dot = document.createElement("span");
        dot.className = "dot";

        if (st && STATUS_COLORS[st]) {
          dot.classList.add("filled");
          dot.style.background = STATUS_COLORS[st];
          dot.style.borderColor = "rgba(255,255,255,.12)";
        } else {
          dot.classList.add("empty");
        }
        dots.appendChild(dot);
      }

      topRow.appendChild(dots);
      cell.appendChild(topRow);

      cell.onclick = () => openGroupDateModal(key);
    } else {
      const num = document.createElement("div");
      num.className = "num";
      num.textContent = String(dayNum);
      if (dec.is_blocked) num.classList.add("num-blocked");
      cell.appendChild(num);

      const st = myStatusMap[key];
      if (st && STATUS_COLORS[st]) {
        const chip = document.createElement("div");
        chip.className = "status-chip";
        chip.style.background = STATUS_COLORS[st];
        cell.appendChild(chip);
      }

      cell.onclick = () => {
        if (!currentChar) {
          openPickCharModal();
          return;
        }
        selected.has(key) ? selected.delete(key) : selected.add(key);
        updateActions();
        renderCalendar();
      };
    }

    el.grid.appendChild(cell);
  }
}

function updateActions() {
  if (mode !== "my") return;

  const enable = selected.size > 0 && !!currentChar;

  if (el.selectedCount) {
    el.selectedCount.textContent = selected.size === 1 ? "1 date selected" : `${selected.size} dates selected`;
  }
  if (el.clearSelectedX) el.clearSelectedX.style.display = selected.size > 0 ? "flex" : "none";

  if (el.actions) el.actions.classList.add("show");
  if (el.btnAvail) el.btnAvail.disabled = !enable;
  if (el.btnVirt) el.btnVirt.disabled = !enable;
  if (el.btnMaybe) el.btnMaybe.disabled = !enable;
  if (el.btnUnavail) el.btnUnavail.disabled = !enable;
  if (el.btnClearStatus) el.btnClearStatus.disabled = !enable;
}

function clearSelected() {
  selected.clear();
  updateActions();
  renderCalendar();
}

/*** 9) WRITE OPS **************************************************************/
function beginWrite() {
  pendingWrites++;
}
function endWrite() {
  pendingWrites = Math.max(0, pendingWrites - 1);
}

async function setStatusBulk(personId, dates, statusOrNull) {
  const status =
    statusOrNull == null || statusOrNull === "" ? null : String(statusOrNull).toLowerCase();

  // Optimistic UI update
  for (const d of dates) {
    if (status === null) delete myStatusMap[d];
    else myStatusMap[d] = status;

    if (!availabilityMap[d]) availabilityMap[d] = Object.create(null);
    if (status === null) delete availabilityMap[d][personId];
    else availabilityMap[d][personId] = status;
  }
  clearSelected();

  beginWrite();
  try {
    if (status === null) {
      for (const d of dates) {
        await sbFetch(
          `availability?group_id=eq.${encodeURIComponent(GROUP_ID)}&person_id=eq.${encodeURIComponent(
            personId
          )}&date=eq.${d}`,
          { method: "DELETE", headers: { Prefer: "return=minimal" } }
        );
      }
    } else {
      const rows = dates.map((d) => ({
        group_id: GROUP_ID,
        person_id: personId,
        date: d,
        status,
        updated_at: new Date().toISOString(),
      }));

      await sbFetch(`availability?on_conflict=group_id,person_id,date`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: rows,
      });
    }
  } finally {
    endWrite();
  }
}

async function upsertDecision(dateKey, patch) {
  const existing = decisionFor(dateKey);
  const next = {
    group_id: GROUP_ID,
    date: dateKey,
    is_blocked: patch.is_blocked != null ? !!patch.is_blocked : !!existing.is_blocked,
    is_confirmed: patch.is_confirmed != null ? !!patch.is_confirmed : !!existing.is_confirmed,
    time_text: patch.time_text != null ? String(patch.time_text) : existing.time_text ?? "",
    updated_at: new Date().toISOString(),
  };

  // optimistic
  decisionsMap[dateKey] = {
    is_blocked: next.is_blocked,
    is_confirmed: next.is_confirmed,
    time_text: next.time_text || "",
  };
  renderCalendar();

  beginWrite();
  try {
    await sbFetch(`decisions?on_conflict=group_id,date`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: [next],
    });
  } finally {
    endWrite();
  }
}

async function enforceSingleConfirmPerMonth(newConfirmedDateKey) {
  const start = monthStart(parseYMD(newConfirmedDateKey));
  const end = monthEndExclusive(parseYMD(newConfirmedDateKey));

  const toUnconfirm = [];
  for (const [k, v] of Object.entries(decisionsMap)) {
    const d = parseYMD(k);
    if (d >= start && d < end && v.is_confirmed && k !== newConfirmedDateKey) {
      toUnconfirm.push(k);
    }
  }

  for (const k of toUnconfirm) {
    await upsertDecision(k, { is_confirmed: false });
  }
}

/*** 10) GROUP MODALS **********************************************************/
function openGroupDateModal(dateKey) {
  activeGroupDateKey = dateKey;

  const dec = decisionFor(dateKey);
  const per = availabilityMap[dateKey] || {};

  if (el.groupDetailTitle) el.groupDetailTitle.textContent = dateTitleShort(dateKey);

  if (el.groupDetailList) {
    el.groupDetailList.innerHTML = "";
    for (const person of PEOPLE) {
      const row = document.createElement("div");
      row.className = "person-row";

      const name = document.createElement("div");
      name.className = "person-name";
      name.textContent = `${person.name}:`;
      name.style.color = person.color;

      const st = per[person.id] || "unknown";
      const val = document.createElement("div");
      val.className = "person-status";
      val.textContent =
        st === "unknown"
          ? "Unknown"
          : st === "available"
          ? "Available"
          : st === "virtual"
          ? "Virtual Only"
          : st === "maybe"
          ? "Maybe"
          : st === "unavailable"
          ? "Unavailable"
          : st;

      row.appendChild(name);
      row.appendChild(val);
      el.groupDetailList.appendChild(row);
    }
  }

  if (el.btnBlockDate) el.btnBlockDate.style.display = dec.is_blocked ? "none" : "inline-flex";
  if (el.btnUnblockDate) el.btnUnblockDate.style.display = dec.is_blocked ? "inline-flex" : "none";

  if (el.btnConfirmDate) el.btnConfirmDate.style.display = dec.is_confirmed ? "none" : "inline-flex";
  if (el.btnCancelConfirm)
    el.btnCancelConfirm.style.display = dec.is_confirmed ? "inline-flex" : "none";

  if (el.btnEditTime) {
    el.btnEditTime.style.display = dec.is_confirmed ? "inline-flex" : "none";
    // If your HTML expects an inner span for label, keep it; otherwise just set text.
    const label = dec.time_text && dec.time_text.trim() ? dec.time_text.trim() : "Add a time";
    const labelEl = el.btnEditTime.querySelector(".btn-label");
    if (labelEl) labelEl.textContent = label;
    else el.btnEditTime.textContent = label;
  }

  if (el.groupDetailModal) el.groupDetailModal.style.display = "flex";
}

function closeGroupDateModal() {
  if (el.groupDetailModal) el.groupDetailModal.style.display = "none";
  activeGroupDateKey = null;
}

function openTimeModal(dateKey) {
  timeModalTargetDateKey = dateKey;

  const d = parseYMD(dateKey);
  if (el.timeModalTitle) {
    // e.g. "Confirming February Date"
    el.timeModalTitle.textContent = `Confirming ${d.toLocaleString(undefined, { month: "long" })} Date`;
  }
  if (el.timeModalSub) el.timeModalSub.textContent = `${DOW[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;

  const dec = decisionFor(dateKey);
  if (el.timeInput) el.timeInput.value = dec.time_text || "";

  if (el.timeModal) el.timeModal.style.display = "flex";
}

function closeTimeModal() {
  if (el.timeModal) el.timeModal.style.display = "none";
  timeModalTargetDateKey = null;
}

/*** 11) EVENT WIRING **********************************************************/
function openPickCharModal() {
  if (el.modalPick) el.modalPick.style.display = "flex";
}
function closePickCharModal() {
  if (el.modalPick) el.modalPick.style.display = "none";
}

function buildCharButtons() {
  if (!el.charGrid) return;
  el.charGrid.innerHTML = "";

  for (const p of PEOPLE) {
    const b = document.createElement("button");
    b.className = "char-btn";
    b.type = "button";
    b.textContent = p.name;
    b.style.background = p.color;
    b.onclick = async () => {
      currentChar = p.id;
      localStorage.setItem("char", currentChar);
      closePickCharModal();

      setLoading(true, "Loading…");
      try {
        await loadMonthData();
      } catch (e) {
        console.error(e);
        alert("Could not load from Supabase. Check table names + columns + RLS policies.");
      } finally {
        setLoading(false);
        renderAll();
      }
    };
    el.charGrid.appendChild(b);
  }
}

function wireEvents() {
  el.modeMy &&
    (el.modeMy.onclick = () => {
      mode = "my";
      localStorage.setItem("mode", mode);
      renderAll();
    });

  el.modeGroup &&
    (el.modeGroup.onclick = async () => {
      mode = "group";
      localStorage.setItem("mode", mode);
      setLoading(true, "Loading…");
      try {
        await loadMonthData();
      } catch (e) {
        console.error(e);
        alert("Could not load from Supabase. Check table names + columns + RLS policies.");
      } finally {
        setLoading(false);
        renderAll();
      }
    });

  // Prev/Next: show overlay + update URL (Step 3) + load
  el.prev &&
    (el.prev.onclick = async () => {
      setLoading(true, "Loading…");
      currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
      updateURLForMonth(currentMonth); // Step 3
      selected.clear();

      try {
        await loadMonthData();
      } catch (e) {
        console.error(e);
        alert("Could not load from Supabase. Check table names + columns + RLS policies.");
      } finally {
        setLoading(false);
        renderAll();
      }
    });

  el.next &&
    (el.next.onclick = async () => {
      setLoading(true, "Loading…");
      currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
      updateURLForMonth(currentMonth); // Step 3
      selected.clear();

      try {
        await loadMonthData();
      } catch (e) {
        console.error(e);
        alert("Could not load from Supabase. Check table names + columns + RLS policies.");
      } finally {
        setLoading(false);
        renderAll();
      }
    });

  el.changeChar && (el.changeChar.onclick = () => openPickCharModal());
  el.clearSelectedX && (el.clearSelectedX.onclick = () => clearSelected());

  el.btnAvail && (el.btnAvail.onclick = () => applyStatus("available"));
  el.btnVirt && (el.btnVirt.onclick = () => applyStatus("virtual"));
  el.btnMaybe && (el.btnMaybe.onclick = () => applyStatus("maybe"));
  el.btnUnavail && (el.btnUnavail.onclick = () => applyStatus("unavailable"));
  el.btnClearStatus && (el.btnClearStatus.onclick = () => applyStatus(null));

  el.groupDetailClose && (el.groupDetailClose.onclick = () => closeGroupDateModal());

  el.btnBlockDate &&
    (el.btnBlockDate.onclick = async () => {
      if (!activeGroupDateKey) return;
      const k = activeGroupDateKey;
      closeGroupDateModal();
      await upsertDecision(k, { is_blocked: true });
      showToast("Date blocked");
      renderAll();
    });

  el.btnUnblockDate &&
    (el.btnUnblockDate.onclick = async () => {
      if (!activeGroupDateKey) return;
      const k = activeGroupDateKey;
      closeGroupDateModal();
      await upsertDecision(k, { is_blocked: false });
      showToast("Date unblocked");
      renderAll();
    });

  el.btnConfirmDate &&
    (el.btnConfirmDate.onclick = async () => {
      if (!activeGroupDateKey) return;
      const k = activeGroupDateKey;
      closeGroupDateModal();

      await upsertDecision(k, { is_confirmed: true });
      await enforceSingleConfirmPerMonth(k);

      openTimeModal(k);
      showToast("Date confirmed");
      renderAll();
    });

  el.btnCancelConfirm &&
    (el.btnCancelConfirm.onclick = async () => {
      if (!activeGroupDateKey) return;
      const k = activeGroupDateKey;
      closeGroupDateModal();

      await upsertDecision(k, { is_confirmed: false }); // block persists if it was blocked
      showToast("Confirmation canceled");
      renderAll();
    });

  el.btnEditTime &&
    (el.btnEditTime.onclick = () => {
      if (!activeGroupDateKey) return;
      const k = activeGroupDateKey;
      closeGroupDateModal();
      openTimeModal(k);
    });

  el.timeClose && (el.timeClose.onclick = () => closeTimeModal());

  el.timeSave &&
    (el.timeSave.onclick = async () => {
      const target = timeModalTargetDateKey;
      if (!target) {
        closeTimeModal();
        return;
      }

      const txt = (el.timeInput?.value || "").trim();
      await upsertDecision(target, { time_text: txt });

      closeTimeModal();
      showToast(txt ? "Time saved" : "Time cleared");
      renderAll();
    });
}

/*** 12) APPLY STATUS ***********************************************************/
async function applyStatus(statusOrNull) {
  if (mode !== "my") return;
  if (!currentChar || selected.size === 0) return;

  const dates = Array.from(selected);

  try {
    await setStatusBulk(currentChar, dates, statusOrNull);
  } catch (e) {
    console.error(e);
    alert("Could not save to Supabase. Check RLS/policies.");
  } finally {
    // gotcha reload: prevents drift between My vs Group view
    try {
      await loadMonthData();
    } catch {}
    renderAll();
  }
}

/*** 14) MAIN RENDER ************************************************************/
function renderAll() {
  renderBanner();
  renderModeButtons();
  renderMonthLabel();
  renderCalendar();
  updateActions();

  if (mode === "group") selected.clear();
}

/*** 15) INIT ******************************************************************/
(async function init() {
  assertConfig();
  buildCharButtons();
  wireEvents();

  // Step 2: set currentMonth from URL if present, else current month.
  currentMonth = getMonthFromURL() || new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  // Optional nice touch: normalize URL to include /MM_YYYY when loaded without it
  // (comment this out if you prefer the root URL to stay plain)
  updateURLForMonth(currentMonth);

  if (!currentChar) openPickCharModal();

  setLoading(true, "Loading…");
  try {
    await loadMonthData();
  } catch (e) {
    console.error(e);
    alert("Could not load from Supabase. Check table names + columns + RLS policies.");
  } finally {
    setLoading(false);
    renderAll();
  }
})();
