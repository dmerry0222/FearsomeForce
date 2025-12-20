/* app.js
   Supabase-backed D&D availability app
   - local-first UI updates
   - group + individual month reads
   - decisions: blocked + confirmed (per month) + optional time text
*/

/* =========================
   CONFIG (PASTE YOUR VALUES)
   ========================= */
const SUPABASE_URL = "https://oafvjbtxcymogqnledns.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9hZnZqYnR4Y3ltb2dxbmxlZG5zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxODIzODUsImV4cCI6MjA4MTc1ODM4NX0.8a22dPhl5x13wyh2e2aoHsp3xAogL-1rJRt48i7Aq2o"; // rotate the one you posted and paste the new one

const GROUP_ID = "fearsomeforce";

/* =========================
   STATIC DATA
   ========================= */
const CHARS = [
  {id:"dandon", name:"Dandon", color:"#8C0A0A"},
  {id:"jassa",  name:"Jassa",  color:"#4D1B5B"},
  {id:"laurel", name:"Laurel", color:"#156D45"},
  {id:"lia",    name:"Lia",    color:"#0F4116"},
  {id:"lilli",  name:"Lilli",  color:"#DB0B91"},
  {id:"silas",  name:"Silas",  color:"#A47D00"}
];

const STATUS_COLORS = {
  available:"#22c55e",
  virtual:"#3b82f6",
  maybe:"#f59e0b",
  unavailable:"#ef4444"
};

const STATUS_LABELS = {
  available:"Available",
  virtual:"Virtual Only",
  maybe:"Maybe",
  unavailable:"Unavailable",
  "": "Unknown",
  null:"Unknown",
  undefined:"Unknown"
};

/* scoring */
const SCORE = { available: 3, virtual: 2, maybe: 1, unknown: 0, unavailable: -3 };
const STAR_MIN_WEIGHED_IN = 4; // your rule

/* =========================
   SUPABASE CLIENT
   ========================= */
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* =========================
   STATE
   ========================= */
let mode = "my"; // "my" | "group"
let currentChar = localStorage.getItem("char") || "";
let selected = new Set();
let month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

let isLoading = false;
let pendingWrites = 0;

/**
 * Month caches:
 * - myMonthMap: { "YYYY-MM-DD": "available" | "virtual" | "maybe" | "unavailable" }
 * - groupMonthMap: {
 *     [date]: { perPerson: {personId: statusOrNull}, counts, score, weighedIn }
 *   }
 */
let myMonthMap = {};
let groupMonthMap = {};

/**
 * Decisions map keyed by date:
 * decisions[date] = { blocked: boolean, confirmed: boolean, time_text: string|null }
 *
 * NOTE: confirmed is stored as "one confirmed per month", but we load into per-date map
 */
let decisions = {};

/* =========================
   DOM
   ========================= */
const banner = document.getElementById("banner");
const bannerTitle = document.getElementById("bannerTitle");
const btnMy = document.getElementById("btnMy");
const btnGroup = document.getElementById("btnGroup");

const selectedCount = document.getElementById("selectedCount");
const selectedPill = document.getElementById("selectedPill");
const clearSelectedX = document.getElementById("clearSelectedX");
const changeBtn = document.getElementById("changeChar");

const monthLabel = document.getElementById("monthLabel");
const loadingTag = document.getElementById("loadingTag");

const prevBtn = document.getElementById("prev");
const nextBtn = document.getElementById("next");
const grid = document.getElementById("grid");

const actions = document.getElementById("actions");
const legend = document.getElementById("legend");

const overlay = document.getElementById("overlay");
const overlayText = document.getElementById("overlayText");

const modalChar = document.getElementById("modalChar");
const closeChar = document.getElementById("closeChar");
const charGrid = document.getElementById("charGrid");

const modalGroupDate = document.getElementById("modalGroupDate");
const closeGroupDate = document.getElementById("closeGroupDate");
const gdTitle = document.getElementById("gdTitle");
const gdPeople = document.getElementById("gdPeople");
const btnBlockDate = document.getElementById("btnBlockDate");
const btnUnblockDate = document.getElementById("btnUnblockDate");
const btnConfirmDate = document.getElementById("btnConfirmDate");
const btnCancelConfirm = document.getElementById("btnCancelConfirm");
const btnTime = document.getElementById("btnTime");

const modalTime = document.getElementById("modalTime");
const timeSave = document.getElementById("timeSave");
const timeDateLabel = document.getElementById("timeDateLabel");
const timeInput = document.getElementById("timeInput");

const toast = document.getElementById("toast");

/* =========================
   UTIL
   ========================= */
const pad = n => String(n).padStart(2,"0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}`;

function monthStartEnd(m){
  const start = new Date(m.getFullYear(), m.getMonth(), 1);
  const end = new Date(m.getFullYear(), m.getMonth()+1, 0);
  return { start, end };
}

function dateTitle(ymdStr){
  // expects YYYY-MM-DD
  const [Y,M,D] = ymdStr.split("-").map(Number);
  const d = new Date(Y, M-1, D);
  return d.toLocaleDateString(undefined, { weekday:"short", month:"short", day:"numeric" });
}

function setBannerTheme(){
  if(mode === "group"){
    bannerTitle.textContent = "Group Availability";
    banner.style.background = "#141b24";
    banner.style.borderColor = "rgba(255,255,255,.16)";
    changeBtn.style.display = "none"; // per your request
    selectedPill.style.visibility = "hidden"; // group view doesn't use multi-select
    return;
  }

  // my
  changeBtn.style.display = "inline-flex";
  selectedPill.style.visibility = "visible";

  const c = CHARS.find(x=>x.id===currentChar);
  if(!c){
    bannerTitle.textContent = "Pick a character";
    banner.style.background = "linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02))";
    banner.style.borderColor = "rgba(255,255,255,.10)";
    selectedPill.style.background = "rgba(255,255,255,.10)";
    return;
  }

  bannerTitle.textContent = `${c.name}'s Availability`;
  banner.style.background = c.color;
  banner.style.borderColor = "rgba(255,255,255,.18)";
  selectedPill.style.background = "rgba(0,0,0,.18)";
}

function showOverlay(text){
  overlayText.textContent = text || "Loading…";
  overlay.style.display = "flex";
}
function hideOverlay(){
  overlay.style.display = "none";
}

function setLoadingTag(on, text){
  isLoading = on;
  loadingTag.style.display = on ? "inline" : "none";
  if(on) loadingTag.textContent = text || "Loading…";
}

function showToast(msg){
  toast.textContent = msg;
  toast.style.display = "block";
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=> toast.style.display="none", 1200);
}

/* =========================
   SUPABASE QUERIES
   ========================= */

/**
 * availability table rows:
 * group_id, date (YYYY-MM-DD), person_id, status, updated_at
 */
async function fetchAvailabilityMonth(groupId, personId, m){
  const { start, end } = monthStartEnd(m);

  const { data, error } = await sb
    .from("availability")
    .select("date,status")
    .eq("group_id", groupId)
    .eq("person_id", personId)
    .gte("date", ymd(start))
    .lte("date", ymd(end));

  if(error) throw error;

  const map = {};
  for(const row of (data || [])){
    map[row.date] = row.status || null;
  }
  return map;
}

async function fetchAvailabilityMonthAll(groupId, m){
  const { start, end } = monthStartEnd(m);

  const { data, error } = await sb
    .from("availability")
    .select("date,person_id,status")
    .eq("group_id", groupId)
    .gte("date", ymd(start))
    .lte("date", ymd(end));

  if(error) throw error;
  return data || [];
}

/**
 * decisions table:
 * group_id, month (YYYY-MM), date (YYYY-MM-DD), blocked boolean, confirmed boolean, time_text text
 *
 * Rules:
 * - one confirmed per group_id + month (enforced by unique partial index or by code)
 * - blocked persists even if confirmed/unconfirmed
 * - time_text persists even if unconfirmed; only shown when confirmed in UI
 */
async function fetchDecisionsMonth(groupId, m){
  const mk = monthKey(m);

  const { data, error } = await sb
    .from("decisions")
    .select("date,blocked,confirmed,time_text")
    .eq("group_id", groupId)
    .eq("month", mk);

  if(error) throw error;

  const map = {};
  for(const row of (data || [])){
    map[row.date] = {
      blocked: !!row.blocked,
      confirmed: !!row.confirmed,
      time_text: row.time_text ?? null
    };
  }
  return map;
}

async function upsertAvailabilityBulk(groupId, personId, dates, statusOrNull){
  // Upsert status rows; if statusOrNull is null -> delete rows for those dates for that person (cleaner)
  const status = (statusOrNull === null || statusOrNull === "" || typeof statusOrNull === "undefined") ? null : String(statusOrNull);

  if(status === null){
    // delete
    const { error } = await sb
      .from("availability")
      .delete()
      .eq("group_id", groupId)
      .eq("person_id", personId)
      .in("date", dates);

    if(error) throw error;
    return;
  }

  const rows = dates.map(d => ({
    group_id: groupId,
    date: d,
    person_id: personId,
    status
  }));

  const { error } = await sb
    .from("availability")
    .upsert(rows, { onConflict: "group_id,date,person_id" });

  if(error) throw error;
}

async function setBlockedForDate(groupId, d, blocked){
  const mk = d.slice(0,7);
  const row = { group_id: groupId, month: mk, date: d, blocked: !!blocked };
  const { error } = await sb
    .from("decisions")
    .upsert(row, { onConflict: "group_id,month,date" });

  if(error) throw error;
}

async function clearConfirmedForMonth(groupId, mk){
  const { error } = await sb
    .from("decisions")
    .update({ confirmed: false })
    .eq("group_id", groupId)
    .eq("month", mk)
    .eq("confirmed", true);

  if(error) throw error;
}

async function setConfirmedForDate(groupId, d, confirmed){
  const mk = d.slice(0,7);

  if(confirmed){
    // enforce 1 confirmed per month
    await clearConfirmedForMonth(groupId, mk);
  }

  const row = { group_id: groupId, month: mk, date: d, confirmed: !!confirmed };
  const { error } = await sb
    .from("decisions")
    .upsert(row, { onConflict: "group_id,month,date" });

  if(error) throw error;
}

async function setTimeText(groupId, d, timeText){
  const mk = d.slice(0,7);
  const row = { group_id: groupId, month: mk, date: d, time_text: (timeText ?? "").trim() };
  const { error } = await sb
    .from("decisions")
    .upsert(row, { onConflict: "group_id,month,date" });

  if(error) throw error;
}

/* =========================
   GROUP AGGREGATION
   ========================= */
function buildGroupMonthMap(rows){
  // init per date structure
  const map = {};
  for(const r of rows){
    const d = r.date;
    if(!map[d]){
      map[d] = {
        perPerson: {},
        counts: { available:0, virtual:0, maybe:0, unavailable:0, unknown: CHARS.length },
        score: 0,
        weighedIn: 0
      };
    }
    map[d].perPerson[r.person_id] = r.status || null;
  }

  // ensure every date has all persons accounted for in perPerson (unknowns)
  for(const d of Object.keys(map)){
    let counts = { available:0, virtual:0, maybe:0, unavailable:0, unknown:0 };
    let score = 0;
    let weighedIn = 0;

    for(const c of CHARS){
      const st = map[d].perPerson[c.id] || null;
      if(!st){
        counts.unknown++;
        score += SCORE.unknown;
      } else {
        if(st === "available") counts.available++;
        else if(st === "virtual") counts.virtual++;
        else if(st === "maybe") counts.maybe++;
        else if(st === "unavailable") counts.unavailable++;
        else counts.unknown++;

        score += SCORE[st] ?? 0;
        weighedIn++;
      }
    }

    map[d].counts = counts;
    map[d].score = score;
    map[d].weighedIn = weighedIn;
  }

  return map;
}

function bestDatesForMonth(map){
  // only consider dates where weighedIn >= STAR_MIN_WEIGHED_IN
  let maxScore = null;
  for(const d of Object.keys(map)){
    if(map[d].weighedIn < STAR_MIN_WEIGHED_IN) continue;
    if(maxScore === null || map[d].score > maxScore) maxScore = map[d].score;
  }
  if(maxScore === null) return new Set();
  const best = new Set();
  for(const d of Object.keys(map)){
    if(map[d].weighedIn >= STAR_MIN_WEIGHED_IN && map[d].score === maxScore){
      best.add(d);
    }
  }
  return best;
}

/* =========================
   RENDER
   ========================= */
function renderHeader(){
  monthLabel.textContent = month.toLocaleString(undefined,{month:"long",year:"numeric"});
  setBannerTheme();

  btnMy.classList.toggle("active", mode==="my");
  btnGroup.classList.toggle("active", mode==="group");

  actions.style.display = (mode==="my") ? "grid" : "none";
  legend.classList.toggle("show", mode==="group");
}

function updateActions(){
  // only meaningful in MY mode
  const size = selected.size;
  selectedCount.textContent = size === 1 ? "1 date selected" : `${size} dates selected`;
  clearSelectedX.style.display = size > 0 ? "flex" : "none";

  const enable = size > 0 && !!currentChar;
  document.querySelectorAll(".action").forEach(b => b.disabled = !enable);
}

function renderCalendar(){
  grid.innerHTML = "";

  const firstDow = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth()+1, 0).getDate();

  const bestSet = (mode==="group") ? bestDatesForMonth(groupMonthMap) : new Set();

  for(let i=0;i<42;i++){
    const day = i - firstDow + 1;
    const cell = document.createElement("div");

    if(day<1 || day>daysInMonth){
      cell.className="cell blank";
      grid.appendChild(cell);
      continue;
    }

    const date = new Date(month.getFullYear(), month.getMonth(), day);
    const key = ymd(date);

    cell.className="cell";

    // persistent decision styling across BOTH views
    const dec = decisions[key] || { blocked:false, confirmed:false, time_text:null };
    if(dec.blocked) cell.classList.add("blocked");
    if(dec.confirmed) cell.classList.add("confirmed");
    if(bestSet.has(key) && !dec.confirmed) cell.classList.add("best"); // confirmed overrides visually (green is “final”)

    // mode-specific innards
    if(mode === "my"){
      const c = document.createElement("div");
      c.className="num";
      if(dec.blocked) c.classList.add("blockedNum");
      c.textContent = String(day);
      cell.appendChild(c);

      if(selected.has(key)) cell.classList.add("selected");

      const status = myMonthMap[key];
      if(status){
        const dot = document.createElement("div");
        dot.className="status-chip";
        dot.style.background = STATUS_COLORS[status] || "transparent";
        cell.appendChild(dot);
      }

      cell.onclick = () => {
        if(!currentChar){
          openCharModal();
          return;
        }
        selected.has(key) ? selected.delete(key) : selected.add(key);
        updateActions();
        renderCalendar();
      };

    } else {
      // group cell: left number, right dot6
      const inner = document.createElement("div");
      inner.className="cell-inner";

      const num = document.createElement("div");
      num.className="num";
      if(dec.blocked) num.classList.add("blockedNum");
      num.textContent = String(day);

      const dot6 = document.createElement("div");
      dot6.className="dot6";

      for(const c of CHARS){
        const d = document.createElement("div");
        d.className="dot";
        const st = groupMonthMap[key]?.perPerson?.[c.id] || null;
        if(st && STATUS_COLORS[st]){
          d.style.background = STATUS_COLORS[st];
          d.style.borderColor = "rgba(255,255,255,.12)";
        } else {
          d.style.background = "rgba(255,255,255,.03)";
          d.style.borderColor = "rgba(255,255,255,.18)";
        }
        dot6.appendChild(d);
      }

      inner.appendChild(num);
      inner.appendChild(dot6);
      cell.appendChild(inner);

      cell.onclick = () => openGroupDateModal(key);
    }

    grid.appendChild(cell);
  }
}

/* =========================
   MODALS
   ========================= */
function openCharModal(){
  modalChar.style.display = "flex";
}
function closeCharModal(){
  modalChar.style.display = "none";
}

function openGroupDateModal(dateStr){
  // build title + list
  gdTitle.textContent = dateTitle(dateStr);

  const per = groupMonthMap[dateStr]?.perPerson || {};
  gdPeople.innerHTML = "";

  for(const c of CHARS){
    const line = document.createElement("div");
    line.className = "person-line";

    const name = document.createElement("div");
    name.className = "pname";
    name.textContent = `${c.name}:`;
    name.style.color = c.color;

    const status = document.createElement("div");
    status.className = "pstatus";
    const st = per[c.id] || null;
    status.textContent = STATUS_LABELS[st] || "Unknown";

    line.appendChild(name);
    line.appendChild(status);
    gdPeople.appendChild(line);
  }

  // action state
  const dec = decisions[dateStr] || { blocked:false, confirmed:false, time_text:null };
  const isBlocked = !!dec.blocked;
  const isConfirmed = !!dec.confirmed;
  const timeText = (dec.time_text || "").trim();

  // block/unblock toggle: if blocked, show unblock; else show block
  btnBlockDate.style.display = isBlocked ? "none" : "flex";
  btnUnblockDate.style.display = isBlocked ? "flex" : "none";

  // confirm / cancel
  btnConfirmDate.style.display = isConfirmed ? "none" : "flex";
  btnCancelConfirm.style.display = isConfirmed ? "flex" : "none";

  // time button only shown when confirmed
  btnTime.style.display = isConfirmed ? "flex" : "none";
  btnTime.textContent = timeText ? `🕒 ${timeText}` : "🕒 Add a time";

  // wire actions
  btnBlockDate.onclick = () => handleBlockToggle(dateStr, true);
  btnUnblockDate.onclick = () => handleBlockToggle(dateStr, false);

  btnConfirmDate.onclick = () => handleConfirm(dateStr);
  btnCancelConfirm.onclick = () => handleCancelConfirm(dateStr);

  btnTime.onclick = () => openTimeModal(dateStr);

  modalGroupDate.style.display = "flex";
}
function closeGroupDateModal(){
  modalGroupDate.style.display = "none";
}

let timeModalDate = null;
function openTimeModal(dateStr){
  timeModalDate = dateStr;
  timeDateLabel.textContent = dateTitle(dateStr);

  // seed input with existing time_text (even if not confirmed we still store it; but we only open time modal from confirmed)
  const dec = decisions[dateStr] || {};
  timeInput.value = (dec.time_text || "").trim();

  modalTime.style.display = "flex";
  timeInput.focus();
}
function closeTimeModal(){
  modalTime.style.display = "none";
  timeModalDate = null;
}

/* =========================
   LOAD / REFRESH
   ========================= */
async function loadMonth(){
  // show loading overlay for initial and month navigation (your request)
  showOverlay("Loading…");
  setLoadingTag(true, "Loading…");

  try{
    // decisions first (so styling can apply even before availability)
    decisions = await fetchDecisionsMonth(GROUP_ID, month);

    if(mode === "my"){
      if(!currentChar){
        myMonthMap = {};
      } else {
        myMonthMap = await fetchAvailabilityMonth(GROUP_ID, currentChar, month);
      }
      // group map not required for my mode
      groupMonthMap = {};
    } else {
      // group mode
      const rows = await fetchAvailabilityMonthAll(GROUP_ID, month);
      groupMonthMap = buildGroupMonthMap(rows);
      // my map still loaded to keep consistency when switching back quickly
      myMonthMap = currentChar ? await fetchAvailabilityMonth(GROUP_ID, currentChar, month) : {};
    }
  } catch(err){
    console.error(err);
    alert("Could not load from Supabase. Check table names + columns + RLS policies.");
  } finally {
    setLoadingTag(false);
    hideOverlay();
    renderHeader();
    updateActions();
    renderCalendar();
  }
}

/* =========================
   LOCAL-FIRST WRITES
   ========================= */
function optimisticSetMyStatus(dates, status){
  for(const d of dates){
    if(status === null) delete myMonthMap[d];
    else myMonthMap[d] = status;
  }
}

function optimisticSetDecision(dateStr, patch){
  const prev = decisions[dateStr] || { blocked:false, confirmed:false, time_text:null };
  decisions[dateStr] = { ...prev, ...patch };
}

function monthConfirmedDate(){
  // return dateStr if any confirmed in current month
  const mk = monthKey(month);
  for(const d of Object.keys(decisions)){
    if(d.startsWith(mk) && decisions[d]?.confirmed) return d;
  }
  return null;
}

async function applyMyStatus(statusOrNull){
  if(!currentChar || selected.size === 0) return;

  const status = (statusOrNull === null || statusOrNull === "" || typeof statusOrNull === "undefined") ? null : String(statusOrNull);
  const dates = Array.from(selected);

  // 1) instant UI
  optimisticSetMyStatus(dates, status);
  selected.clear();
  updateActions();
  renderCalendar();

  // 2) background sync
  pendingWrites++;
  setLoadingTag(true, "Syncing…");

  upsertAvailabilityBulk(GROUP_ID, currentChar, dates, status)
    .then(()=> showToast("Saved"))
    .catch(err=>{
      console.error(err);
      alert("Save failed. Reload to re-sync.");
    })
    .finally(async ()=>{
      pendingWrites--;
      if(pendingWrites > 0) return;

      // refresh just the relevant maps to prevent “dots disappear/reappear” flicker:
      // Instead of wiping and rebuilding UI mid-flight, we only refresh once when idle.
      try{
        myMonthMap = currentChar ? await fetchAvailabilityMonth(GROUP_ID, currentChar, month) : {};
        if(mode === "group"){
          const rows = await fetchAvailabilityMonthAll(GROUP_ID, month);
          groupMonthMap = buildGroupMonthMap(rows);
        }
      } catch(e){
        console.warn("Post-sync refresh failed; keeping local view", e);
      } finally {
        setLoadingTag(false);
        renderCalendar();
      }
    });
}

/* =========================
   GROUP DECISION ACTIONS
   ========================= */
function handleBlockToggle(dateStr, blockOn){
  // close modal immediately, local-first
  closeGroupDateModal();

  optimisticSetDecision(dateStr, { blocked: !!blockOn });
  renderCalendar();

  pendingWrites++;
  setLoadingTag(true, "Syncing…");

  setBlockedForDate(GROUP_ID, dateStr, !!blockOn)
    .then(()=> showToast(blockOn ? "Date blocked" : "Date available"))
    .catch(err=>{
      console.error(err);
      alert("Could not update blocked status. Reload to retry.");
    })
    .finally(async ()=>{
      pendingWrites--;
      if(pendingWrites > 0) return;

      // refresh decisions for the month only
      try{
        decisions = await fetchDecisionsMonth(GROUP_ID, month);
      } catch(e){
        console.warn("Decision refresh failed; keeping local", e);
      } finally {
        setLoadingTag(false);
        renderCalendar();
      }
    });
}

function handleConfirm(dateStr){
  // close date modal immediately then open time modal
  closeGroupDateModal();

  const mk = dateStr.slice(0,7);
  const previouslyConfirmed = monthConfirmedDate();

  // local-first: unconfirm previous date in same month, confirm this
  if(previouslyConfirmed && previouslyConfirmed !== dateStr && previouslyConfirmed.startsWith(mk)){
    optimisticSetDecision(previouslyConfirmed, { confirmed:false });
  }
  optimisticSetDecision(dateStr, { confirmed:true });

  renderCalendar();

  // open time modal (request optional input)
  openTimeModal(dateStr);

  // background sync confirmation (time will be saved separately)
  pendingWrites++;
  setLoadingTag(true, "Syncing…");

  setConfirmedForDate(GROUP_ID, dateStr, true)
    .then(()=> showToast("Confirmed"))
    .catch(err=>{
      console.error(err);
      alert("Could not confirm date. Reload to retry.");
    })
    .finally(async ()=>{
      pendingWrites--;
      if(pendingWrites > 0) return;

      try{
        decisions = await fetchDecisionsMonth(GROUP_ID, month);
      } catch(e){
        console.warn("Decision refresh failed; keeping local", e);
      } finally {
        setLoadingTag(false);
        renderCalendar();
      }
    });
}

function handleCancelConfirm(dateStr){
  closeGroupDateModal();

  // local-first: confirmed false, but DO NOT clear time_text or blocked flag
  optimisticSetDecision(dateStr, { confirmed:false });
  renderCalendar();

  pendingWrites++;
  setLoadingTag(true, "Syncing…");

  setConfirmedForDate(GROUP_ID, dateStr, false)
    .then(()=> showToast("Confirmation removed"))
    .catch(err=>{
      console.error(err);
      alert("Could not remove confirmation. Reload to retry.");
    })
    .finally(async ()=>{
      pendingWrites--;
      if(pendingWrites > 0) return;

      try{
        decisions = await fetchDecisionsMonth(GROUP_ID, month);
      } catch(e){
        console.warn("Decision refresh failed; keeping local", e);
      } finally {
        setLoadingTag(false);
        renderCalendar();
      }
    });
}

function handleSaveTime(){
  if(!timeModalDate) return;

  const d = timeModalDate;
  const txt = (timeInput.value || "").trim();

  // local-first store (persists even if later unconfirmed)
  optimisticSetDecision(d, { time_text: txt });
  closeTimeModal();
  showToast("Saved");
  renderCalendar();

  pendingWrites++;
  setLoadingTag(true, "Syncing…");

  setTimeText(GROUP_ID, d, txt)
    .catch(err=>{
      console.error(err);
      alert("Could not save time text. Reload to retry.");
    })
    .finally(async ()=>{
      pendingWrites--;
      if(pendingWrites > 0) return;

      try{
        decisions = await fetchDecisionsMonth(GROUP_ID, month);
      } catch(e){
        console.warn("Decision refresh failed; keeping local", e);
      } finally {
        setLoadingTag(false);
        renderCalendar();
      }
    });
}

/* =========================
   WIRES
   ========================= */
function wireCharPicker(){
  charGrid.innerHTML = "";
  for(const c of CHARS){
    const b = document.createElement("button");
    b.className = "char-btn";
    b.style.background = c.color;
    b.textContent = c.name;
    b.type = "button";
    b.onclick = async () => {
      currentChar = c.id;
      localStorage.setItem("char", c.id);
      closeCharModal();
      selected.clear();
      renderHeader();
      updateActions();
      await loadMonth();
    };
    charGrid.appendChild(b);
  }
}

btnMy.onclick = async () => {
  mode = "my";
  selected.clear();
  renderHeader();
  updateActions();
  await loadMonth();
};

btnGroup.onclick = async () => {
  mode = "group";
  selected.clear();
  renderHeader();
  updateActions();
  await loadMonth();
};

changeBtn.onclick = () => openCharModal();
closeChar.onclick = () => closeCharModal();
modalChar.onclick = (e) => { if(e.target === modalChar) closeCharModal(); };

clearSelectedX.onclick = () => {
  selected.clear();
  updateActions();
  renderCalendar();
};

document.getElementById("avail").onclick = () => applyMyStatus("available");
document.getElementById("virt").onclick = () => applyMyStatus("virtual");
document.getElementById("maybe").onclick = () => applyMyStatus("maybe");
document.getElementById("unavail").onclick = () => applyMyStatus("unavailable");
document.getElementById("clearStatus").onclick = () => applyMyStatus(null);

prevBtn.onclick = async () => {
  month = new Date(month.getFullYear(), month.getMonth()-1, 1);
  selected.clear();
  renderHeader();
  updateActions();
  await loadMonth();
};

nextBtn.onclick = async () => {
  month = new Date(month.getFullYear(), month.getMonth()+1, 1);
  selected.clear();
  renderHeader();
  updateActions();
  await loadMonth();
};

closeGroupDate.onclick = () => closeGroupDateModal();
modalGroupDate.onclick = (e) => { if(e.target === modalGroupDate) closeGroupDateModal(); };

timeSave.onclick = () => handleSaveTime();
modalTime.onclick = (e) => { if(e.target === modalTime) closeTimeModal(); };

/* =========================
   INIT
   ========================= */
(function init(){
  wireCharPicker();

  // initial mode default
  mode = "my";
  renderHeader();
  updateActions();

  // if no char selected, prompt
  if(!currentChar) openCharModal();

  // initial load
  loadMonth();
})();
