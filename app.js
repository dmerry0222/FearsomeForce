/* app.js — full overwrite (Supabase + calendar UI logic)
   Expects tables:
   - people:      group_id (text), person_id (text), name (text), color (text), sort_order (int)
   - availability:group_id (text), date (date), person_id (text), status (text), updated_at (timestamptz)
   - decisions:   group_id (text), date (date), is_blocked (bool), is_confirmed (bool), time_text (text), updated_at (timestamptz)

   Status values expected (lowercase): available | virtual | maybe | unavailable
*/

(() => {
  // =========================
  // CONFIG
  // =========================
  const SUPABASE_URL = window.__SUPABASE_URL__;
  const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY__;
  const GROUP_ID = window.__GROUP_ID__ || "fearsomeforce";

  // “Best day” scoring
  const SCORE = { available: 3, virtual: 2, maybe: 1, unavailable: -3 };
  const MIN_WEIGHED_IN_FOR_BEST = 4; // your rule

  // UI colors for statuses (dots)
  const STATUS_COLORS = {
    available: "#22c55e",
    virtual: "#3b82f6",
    maybe: "#f59e0b",
    unavailable: "#ef4444",
  };

  // =========================
  // SUPABASE CLIENT
  // =========================
  const supabase = window.supabase?.createClient
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

  if (!supabase) {
    alert("Supabase client not found. Make sure supabase-js is loaded in Index.html.");
    return;
  }

  // =========================
  // STATE
  // =========================
  const state = {
    mode: "my", // "my" | "group"
    currentPersonId: localStorage.getItem("person_id") || "",
    month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),

    people: [], // [{person_id, name, color, sort_order}]
    availabilityByDate: {}, // { 'YYYY-MM-DD': { person_id: status } }
    myStatusByDate: {}, // { 'YYYY-MM-DD': status }
    decisionsByDate: {}, // { 'YYYY-MM-DD': { is_blocked, is_confirmed, time_text } }

    selectedDates: new Set(), // used in My Availability selection
  };

  // =========================
  // HELPERS
  // =========================
  const pad2 = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  function monthRange(monthDate) {
    const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const end = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1);
    return { startStr: ymd(start), endStr: ymd(end) };
  }

  function niceDateTitle(dateStr) {
    // "Wed, Dec 17"
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  function monthLabel(monthDate) {
    return monthDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  // =========================
  // GOTCHA CHECK (your ask)
  // =========================
  async function gotchaCheck() {
    // 1) decisions columns
    const dec = await supabase
      .from("decisions")
      .select("group_id,date,is_blocked,is_confirmed,time_text")
      .eq("group_id", GROUP_ID)
      .limit(1);

    if (dec.error) {
      console.error(dec.error);
      throw new Error(
        "Could not read from 'decisions'. Check table name + RLS policies."
      );
    }

    // 2) availability columns
    const av = await supabase
      .from("availability")
      .select("group_id,date,person_id,status")
      .eq("group_id", GROUP_ID)
      .limit(1);

    if (av.error) {
      console.error(av.error);
      throw new Error(
        "Could not read from 'availability'. Check table name + RLS policies."
      );
    }

    // 3) people columns
    const ppl = await supabase
      .from("people")
      .select("group_id,person_id,name,color,sort_order")
      .eq("group_id", GROUP_ID)
      .limit(1);

    if (ppl.error) {
      console.error(ppl.error);
      throw new Error("Could not read from 'people'. Check table name + RLS policies.");
    }
  }

  // =========================
  // LOADING DATA (month)
  // =========================
  async function loadPeople() {
    const { data, error } = await supabase
      .from("people")
      .select("person_id,name,color,sort_order")
      .eq("group_id", GROUP_ID)
      .order("sort_order", { ascending: true });

    if (error) throw error;

    state.people = data || [];

    // If people table empty, fall back to your known six (so app doesn’t break)
    if (!state.people.length) {
      state.people = [
        { person_id: "dandon", name: "Dandon", color: "#8C0A0A", sort_order: 1 },
        { person_id: "jassa", name: "Jassa", color: "#4D1B5B", sort_order: 2 },
        { person_id: "laurel", name: "Laurel", color: "#156D45", sort_order: 3 },
        { person_id: "lia", name: "Lia", color: "#0F4116", sort_order: 4 },
        { person_id: "lilli", name: "Lilli", color: "#DB0B91", sort_order: 5 },
        { person_id: "silas", name: "Silas", color: "#A47D00", sort_order: 6 },
      ];
    }
  }

  async function loadMonthData() {
    const { startStr, endStr } = monthRange(state.month);

    // decisions for month
    const decRes = await supabase
      .from("decisions")
      .select("date,is_blocked,is_confirmed,time_text")
      .eq("group_id", GROUP_ID)
      .gte("date", startStr)
      .lt("date", endStr);

    if (decRes.error) throw decRes.error;

    state.decisionsByDate = {};
    for (const row of decRes.data || []) {
      // date from Supabase can come as "YYYY-MM-DD"
      state.decisionsByDate[row.date] = {
        is_blocked: !!row.is_blocked,
        is_confirmed: !!row.is_confirmed,
        time_text: row.time_text || "",
      };
    }

    // availability for month
    const avRes = await supabase
      .from("availability")
      .select("date,person_id,status")
      .eq("group_id", GROUP_ID)
      .gte("date", startStr)
      .lt("date", endStr);

    if (avRes.error) throw avRes.error;

    state.availabilityByDate = {};
    for (const row of avRes.data || []) {
      if (!state.availabilityByDate[row.date]) state.availabilityByDate[row.date] = {};
      state.availabilityByDate[row.date][row.person_id] = row.status;
    }

    // derive myStatusByDate
    state.myStatusByDate = {};
    if (state.currentPersonId) {
      for (const [dateStr, perMap] of Object.entries(state.availabilityByDate)) {
        if (perMap[state.currentPersonId]) {
          state.myStatusByDate[dateStr] = perMap[state.currentPersonId];
        }
      }
    }
  }

  // =========================
  // WRITE HELPERS (local-first)
  // =========================
  async function upsertAvailabilityBulk(personId, dateStrs, statusOrNull) {
    // optimistic local update
    for (const ds of dateStrs) {
      if (!state.availabilityByDate[ds]) state.availabilityByDate[ds] = {};
      if (!statusOrNull) delete state.availabilityByDate[ds][personId];
      else state.availabilityByDate[ds][personId] = statusOrNull;

      if (personId === state.currentPersonId) {
        if (!statusOrNull) delete state.myStatusByDate[ds];
        else state.myStatusByDate[ds] = statusOrNull;
      }
    }

    render();

    // write
    if (!statusOrNull) {
      // delete rows
      const { error } = await supabase
        .from("availability")
        .delete()
        .eq("group_id", GROUP_ID)
        .eq("person_id", personId)
        .in("date", dateStrs);

      if (error) throw error;
    } else {
      // upsert rows
      const payload = dateStrs.map((ds) => ({
        group_id: GROUP_ID,
        date: ds,
        person_id: personId,
        status: statusOrNull,
      }));

      const { error } = await supabase
        .from("availability")
        .upsert(payload, { onConflict: "group_id,date,person_id" });

      if (error) throw error;
    }
  }

  async function setBlocked(dateStr, isBlocked) {
    // optimistic
    if (!state.decisionsByDate[dateStr]) state.decisionsByDate[dateStr] = { is_blocked: false, is_confirmed: false, time_text: "" };
    state.decisionsByDate[dateStr].is_blocked = !!isBlocked;
    render();

    const payload = {
      group_id: GROUP_ID,
      date: dateStr,
      is_blocked: !!isBlocked,
      // do NOT overwrite confirm/time unless we explicitly include them.
    };

    const { error } = await supabase
      .from("decisions")
      .upsert(payload, { onConflict: "group_id,date" });

    if (error) throw error;
  }

  async function setConfirmedForMonth(dateStr, confirm, timeTextMaybe) {
    const [y, m] = dateStr.split("-").map(Number);
    const monthStart = `${y}-${pad2(m)}-01`;
    const nextMonth = new Date(y, m, 1); // JS month index: m is 1-based here so OK by Date? careful:
    // safer:
    const monthStartDate = new Date(y, m - 1, 1);
    const monthEndDate = new Date(y, m, 1);
    const monthEnd = ymd(monthEndDate);

    // optimistic:
    // ensure record exists
    if (!state.decisionsByDate[dateStr]) state.decisionsByDate[dateStr] = { is_blocked: false, is_confirmed: false, time_text: "" };

    if (confirm) {
      // unconfirm any other date in same month locally
      for (const [d, obj] of Object.entries(state.decisionsByDate)) {
        if (d >= monthStart && d < monthEnd) obj.is_confirmed = false;
      }
      state.decisionsByDate[dateStr].is_confirmed = true;
      if (typeof timeTextMaybe === "string") state.decisionsByDate[dateStr].time_text = timeTextMaybe;
    } else {
      // cancel confirm, keep time_text
      state.decisionsByDate[dateStr].is_confirmed = false;
    }
    render();

    // write step 1: if confirming, set the chosen date confirmed true (and optionally time_text)
    if (confirm) {
      const payload = {
        group_id: GROUP_ID,
        date: dateStr,
        is_confirmed: true,
      };
      if (typeof timeTextMaybe === "string") payload.time_text = timeTextMaybe;

      let r = await supabase.from("decisions").upsert(payload, { onConflict: "group_id,date" });
      if (r.error) throw r.error;

      // write step 2: unconfirm other dates in that month (do NOT touch is_blocked or time_text)
      const r2 = await supabase
        .from("decisions")
        .update({ is_confirmed: false })
        .eq("group_id", GROUP_ID)
        .gte("date", monthStart)
        .lt("date", monthEnd)
        .neq("date", dateStr);

      if (r2.error) throw r2.error;
    } else {
      // cancelling confirmation: set is_confirmed false for that date only
      const r = await supabase
        .from("decisions")
        .upsert({ group_id: GROUP_ID, date: dateStr, is_confirmed: false }, { onConflict: "group_id,date" });

      if (r.error) throw r.error;
    }
  }

  async function setTimeText(dateStr, timeText) {
    if (!state.decisionsByDate[dateStr]) state.decisionsByDate[dateStr] = { is_blocked: false, is_confirmed: false, time_text: "" };
    state.decisionsByDate[dateStr].time_text = timeText || "";
    render();

    const r = await supabase
      .from("decisions")
      .upsert({ group_id: GROUP_ID, date: dateStr, time_text: timeText || "" }, { onConflict: "group_id,date" });

    if (r.error) throw r.error;
  }

  // =========================
  // BEST DAY CALC
  // =========================
  function computeBestDaysForMonth() {
    const { startStr, endStr } = monthRange(state.month);
    const best = { maxScore: -Infinity, dates: new Set() };

    // gather all date strings in range that exist in the calendar month
    const start = new Date(state.month.getFullYear(), state.month.getMonth(), 1);
    const daysInMonth = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 0).getDate();

    for (let day = 1; day <= daysInMonth; day++) {
      const ds = ymd(new Date(start.getFullYear(), start.getMonth(), day));
      if (ds < startStr || ds >= endStr) continue;

      const per = state.availabilityByDate[ds] || {};
      const statuses = Object.values(per);
      const weighedIn = statuses.filter((s) => !!s).length;

      if (weighedIn < MIN_WEIGHED_IN_FOR_BEST) continue;

      let score = 0;
      for (const pid of state.people.map((p) => p.person_id)) {
        const st = per[pid];
        if (!st) continue;
        score += (SCORE[st] ?? 0);
      }

      if (score > best.maxScore) {
        best.maxScore = score;
        best.dates = new Set([ds]);
      } else if (score === best.maxScore && best.maxScore !== -Infinity) {
        best.dates.add(ds);
      }
    }

    return best.dates;
  }

  // =========================
  // RENDER HOOKS (expects IDs from Index.html)
  // =========================
  const els = {
    // you already have these in your Index.html; this app.js expects them to exist:
    bannerTitle: document.getElementById("bannerTitle"),
    banner: document.getElementById("banner"),
    monthLabel: document.getElementById("monthLabel"),
    grid: document.getElementById("grid"),
    loadingModal: document.getElementById("loadingModal"),
    modeMyBtn: document.getElementById("modeMy"),
    modeGroupBtn: document.getElementById("modeGroup"),
    prevBtn: document.getElementById("prev"),
    nextBtn: document.getElementById("next"),

    // My availability action buttons
    actionsWrap: document.getElementById("actions"),
    btnAvail: document.getElementById("avail"),
    btnVirt: document.getElementById("virt"),
    btnMaybe: document.getElementById("maybe"),
    btnUnavail: document.getElementById("unavail"),
    btnClearStatus: document.getElementById("clearStatus"),

    // “Who are you?” picker modal
    whoModal: document.getElementById("whoModal"),
    whoGrid: document.getElementById("whoGrid"),
    changePersonBtn: document.getElementById("changePerson"),

    // Group day detail modal
    dayModal: document.getElementById("dayModal"),
    dayModalTitle: document.getElementById("dayModalTitle"),
    dayModalList: document.getElementById("dayModalList"),
    dayModalClose: document.getElementById("dayModalClose"),
    btnBlock: document.getElementById("btnBlock"),
    btnUnblock: document.getElementById("btnUnblock"),
    btnConfirm: document.getElementById("btnConfirm"),
    btnCancelConfirm: document.getElementById("btnCancelConfirm"),
    btnTime: document.getElementById("btnTime"),

    // Confirming “toast modal”
    confirmModal: document.getElementById("confirmModal"),
    confirmTitle: document.getElementById("confirmTitle"),
    confirmSub: document.getElementById("confirmSub"),
    confirmInput: document.getElementById("confirmInput"),
    confirmDone: document.getElementById("confirmDone"),
  };

  function showLoading(on) {
    if (!els.loadingModal) return;
    els.loadingModal.style.display = on ? "flex" : "none";
  }

  function ensurePersonPicked() {
    if (!state.currentPersonId) {
      if (els.whoModal) els.whoModal.style.display = "flex";
      return false;
    }
    return true;
  }

  function setMode(mode) {
    state.mode = mode;
    render();
  }

  // =========================
  // CELL CLASSES (blocked/best/confirmed)
  // =========================
  function decisionFor(ds) {
    return state.decisionsByDate[ds] || { is_blocked: false, is_confirmed: false, time_text: "" };
  }

  function cellDecorations(ds, bestDatesSet) {
    const d = decisionFor(ds);
    return {
      blocked: d.is_blocked,
      confirmed: d.is_confirmed,
      best: bestDatesSet.has(ds),
    };
  }

  // =========================
  // RENDER
  // =========================
  function render() {
    // banner
    if (els.modeMyBtn && els.modeGroupBtn) {
      els.modeMyBtn.classList.toggle("active", state.mode === "my");
      els.modeGroupBtn.classList.toggle("active", state.mode === "group");
    }

    const currentPerson = state.people.find((p) => p.person_id === state.currentPersonId);
    if (els.bannerTitle) {
      els.bannerTitle.textContent =
        state.mode === "group"
          ? "Group Availability"
          : currentPerson
          ? `${currentPerson.name}'s Availability`
          : "Pick a character";
    }

    if (els.banner) {
      if (state.mode === "group") {
        els.banner.style.background = "#111827"; // dark grey
      } else if (currentPerson) {
        els.banner.style.background = currentPerson.color;
      } else {
        els.banner.style.background = "";
      }
    }

    // show/hide change person button in group mode
    if (els.changePersonBtn) {
      els.changePersonBtn.style.display = state.mode === "group" ? "none" : "inline-flex";
    }

    // month label
    if (els.monthLabel) els.monthLabel.textContent = monthLabel(state.month);

    // actions: ALWAYS visible in My mode; disabled when no selection
    if (els.actionsWrap) {
      els.actionsWrap.style.display = state.mode === "my" ? "grid" : "none";
      const enable = state.mode === "my" && state.selectedDates.size > 0 && !!state.currentPersonId;
      if (els.btnAvail) els.btnAvail.disabled = !enable;
      if (els.btnVirt) els.btnVirt.disabled = !enable;
      if (els.btnMaybe) els.btnMaybe.disabled = !enable;
      if (els.btnUnavail) els.btnUnavail.disabled = !enable;
      if (els.btnClearStatus) els.btnClearStatus.disabled = !enable;
    }

    // calendar grid
    if (!els.grid) return;

    const bestDates = computeBestDaysForMonth();

    const firstDow = new Date(state.month.getFullYear(), state.month.getMonth(), 1).getDay();
    const daysInMonth = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 0).getDate();

    els.grid.innerHTML = "";

    for (let i = 0; i < 42; i++) {
      const day = i - firstDow + 1;
      const cell = document.createElement("div");

      if (day < 1 || day > daysInMonth) {
        cell.className = "cell blank";
        els.grid.appendChild(cell);
        continue;
      }

      const ds = ymd(new Date(state.month.getFullYear(), state.month.getMonth(), day));
      const dec = cellDecorations(ds, bestDates);

      cell.className = "cell";
      if (dec.best) cell.classList.add("best");
      if (dec.confirmed) cell.classList.add("confirmed");
      if (dec.blocked) cell.classList.add("blocked");

      // selection highlight only in my mode
      if (state.mode === "my" && state.selectedDates.has(ds)) cell.classList.add("selected");

      // layout: date in its own lane; dots to the right in group mode
      // (Your CSS should support .cell-inner / .date-col / .dots-col.)
      const inner = document.createElement("div");
      inner.className = "cell-inner";

      const dateCol = document.createElement("div");
      dateCol.className = "date-col";

      const num = document.createElement("div");
      num.className = "num";
      num.textContent = String(day);
      dateCol.appendChild(num);

      inner.appendChild(dateCol);

      const dotsCol = document.createElement("div");
      dotsCol.className = "dots-col";

      if (state.mode === "my") {
        const st = state.myStatusByDate[ds];
        if (st) {
          const dot = document.createElement("div");
          dot.className = "status-chip";
          dot.style.background = STATUS_COLORS[st] || "transparent";
          dotsCol.appendChild(dot);
        }
      } else {
        // group mode: sextuplet dot grid
        const per = state.availabilityByDate[ds] || {};
        const dotGrid = document.createElement("div");
        dotGrid.className = "dot-grid";

        for (const p of state.people) {
          const st = per[p.person_id];
          const d = document.createElement("div");
          d.className = "dot";
          if (st) {
            d.classList.add("filled");
            d.style.background = STATUS_COLORS[st] || "transparent";
            d.style.borderColor = STATUS_COLORS[st] || "transparent";
          } else {
            d.style.background = "transparent";
            d.style.borderColor = "rgba(255,255,255,.28)";
          }
          dotGrid.appendChild(d);
        }

        dotsCol.appendChild(dotGrid);
      }

      inner.appendChild(dotsCol);
      cell.appendChild(inner);

      // click behavior
      cell.addEventListener("click", () => {
        if (state.mode === "my") {
          if (!ensurePersonPicked()) return;
          if (state.selectedDates.has(ds)) state.selectedDates.delete(ds);
          else state.selectedDates.add(ds);
          render();
        } else {
          // open day modal
          openDayModal(ds);
        }
      });

      els.grid.appendChild(cell);
    }
  }

  // =========================
  // MODALS (Group day modal + confirm modal)
  // =========================
  let modalDate = null;

  function openDayModal(ds) {
    modalDate = ds;

    const dec = decisionFor(ds);
    const per = state.availabilityByDate[ds] || {};

    if (els.dayModalTitle) els.dayModalTitle.textContent = `${niceDateTitle(ds)}`;
    if (els.dayModalList) {
      els.dayModalList.innerHTML = "";
      for (const p of state.people) {
        const row = document.createElement("div");
        row.className = "day-row";

        const name = document.createElement("div");
        name.className = "day-name";
        name.textContent = `${p.name}:`;
        name.style.color = p.color;

        const st = document.createElement("div");
        st.className = "day-status";
        st.textContent = per[p.person_id] ? humanStatus(per[p.person_id]) : "Unknown";

        row.appendChild(name);
        row.appendChild(st);
        els.dayModalList.appendChild(row);
      }
    }

    // button visibilities
    if (els.btnBlock) els.btnBlock.style.display = dec.is_blocked ? "none" : "inline-flex";
    if (els.btnUnblock) els.btnUnblock.style.display = dec.is_blocked ? "inline-flex" : "none";

    if (els.btnConfirm) els.btnConfirm.style.display = dec.is_confirmed ? "none" : "inline-flex";
    if (els.btnCancelConfirm) els.btnCancelConfirm.style.display = dec.is_confirmed ? "inline-flex" : "none";

    if (els.btnTime) {
      els.btnTime.style.display = dec.is_confirmed ? "inline-flex" : "none";
      els.btnTime.textContent = dec.time_text ? `🕒 ${dec.time_text}` : "🕒 Add a time";
    }

    if (els.dayModal) els.dayModal.style.display = "flex";
  }

  function closeDayModal() {
    if (els.dayModal) els.dayModal.style.display = "none";
    modalDate = null;
  }

  function openConfirmModal(ds) {
    const dec = decisionFor(ds);
    if (els.confirmTitle) els.confirmTitle.textContent = "Confirming December Date";
    if (els.confirmSub) els.confirmSub.textContent = niceDateTitle(ds);
    if (els.confirmInput) els.confirmInput.value = dec.time_text || "";
    if (els.confirmModal) els.confirmModal.style.display = "flex";
  }

  function closeConfirmModal() {
    if (els.confirmModal) els.confirmModal.style.display = "none";
  }

  function humanStatus(st) {
    switch (st) {
      case "available": return "Available";
      case "virtual": return "Virtual Only";
      case "maybe": return "Maybe";
      case "unavailable": return "Unavailable";
      default: return st || "Unknown";
    }
  }

  // =========================
  // EVENT WIRING
  // =========================
  async function init() {
    try {
      showLoading(true);
      await gotchaCheck();
      await loadPeople();
      await loadMonthData();
      render();
    } catch (e) {
      console.error(e);
      alert(String(e.message || e));
    } finally {
      showLoading(false);
    }

    // mode buttons
    if (els.modeMyBtn) els.modeMyBtn.addEventListener("click", () => setMode("my"));
    if (els.modeGroupBtn) els.modeGroupBtn.addEventListener("click", () => setMode("group"));

    // month nav (re-show loading modal on month change)
    if (els.prevBtn) els.prevBtn.addEventListener("click", async () => {
      try {
        showLoading(true);
        state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
        state.selectedDates.clear();
        await loadMonthData();
        render();
      } catch (e) {
        console.error(e);
        alert("Could not load month. Check Supabase tables + RLS.");
      } finally {
        showLoading(false);
      }
    });

    if (els.nextBtn) els.nextBtn.addEventListener("click", async () => {
      try {
        showLoading(true);
        state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1);
        state.selectedDates.clear();
        await loadMonthData();
        render();
      } catch (e) {
        console.error(e);
        alert("Could not load month. Check Supabase tables + RLS.");
      } finally {
        showLoading(false);
      }
    });

    // My status buttons
    if (els.btnAvail) els.btnAvail.addEventListener("click", () => applyMyStatus("available"));
    if (els.btnVirt) els.btnVirt.addEventListener("click", () => applyMyStatus("virtual"));
    if (els.btnMaybe) els.btnMaybe.addEventListener("click", () => applyMyStatus("maybe"));
    if (els.btnUnavail) els.btnUnavail.addEventListener("click", () => applyMyStatus("unavailable"));
    if (els.btnClearStatus) els.btnClearStatus.addEventListener("click", () => applyMyStatus(null));

    async function applyMyStatus(statusOrNull) {
      if (!ensurePersonPicked()) return;
      if (!state.selectedDates.size) return;
      const dates = Array.from(state.selectedDates);
      state.selectedDates.clear();
      render();

      try {
        await upsertAvailabilityBulk(state.currentPersonId, dates, statusOrNull);
      } catch (e) {
        console.error(e);
        alert("Could not save availability. Check RLS policies.");
        // reload to reconcile
        try {
          showLoading(true);
          await loadMonthData();
          render();
        } finally {
          showLoading(false);
        }
      }
    }

    // Who modal
    if (els.changePersonBtn) {
      els.changePersonBtn.addEventListener("click", () => {
        if (els.whoModal) els.whoModal.style.display = "flex";
      });
    }

    if (els.whoGrid) {
      els.whoGrid.innerHTML = "";
      for (const p of state.people) {
        const b = document.createElement("button");
        b.className = "char-btn";
        b.type = "button";
        b.textContent = p.name;
        b.style.background = p.color;
        b.addEventListener("click", async () => {
          state.currentPersonId = p.person_id;
          localStorage.setItem("person_id", p.person_id);
          if (els.whoModal) els.whoModal.style.display = "none";
          showLoading(true);
          try {
            await loadMonthData();
            render();
          } finally {
            showLoading(false);
          }
        });
        els.whoGrid.appendChild(b);
      }
    }

    // Day modal buttons
    if (els.dayModalClose) els.dayModalClose.addEventListener("click", closeDayModal);

    if (els.btnBlock) els.btnBlock.addEventListener("click", async () => {
      if (!modalDate) return;
      const d = modalDate;
      closeDayModal();
      try { await setBlocked(d, true); } catch (e) { console.error(e); alert("Could not block date (RLS?)."); }
    });

    if (els.btnUnblock) els.btnUnblock.addEventListener("click", async () => {
      if (!modalDate) return;
      const d = modalDate;
      closeDayModal();
      try { await setBlocked(d, false); } catch (e) { console.error(e); alert("Could not unblock date (RLS?)."); }
    });

    if (els.btnConfirm) els.btnConfirm.addEventListener("click", async () => {
      if (!modalDate) return;
      const d = modalDate;
      closeDayModal();
      // confirm closes day modal and opens confirm modal for optional time input
      openConfirmModal(d);
    });

    if (els.btnCancelConfirm) els.btnCancelConfirm.addEventListener("click", async () => {
      if (!modalDate) return;
      const d = modalDate;
      closeDayModal();
      try {
        await setConfirmedForMonth(d, false);
      } catch (e) {
        console.error(e);
        alert("Could not cancel confirmation (RLS?).");
      }
    });

    if (els.btnTime) els.btnTime.addEventListener("click", () => {
      if (!modalDate) return;
      const d = modalDate;
      closeDayModal();
      openConfirmModal(d);
    });

    // Confirm modal “done”
    if (els.confirmDone) {
      els.confirmDone.addEventListener("click", async () => {
        const ds = modalDate; // modalDate still tracks the date the user last opened
        // If modalDate got nulled because we closed the day modal, store it in a safer way:
        // We'll recover from confirmSub text if needed; but easiest is to keep a separate var.
      });
    }

    // We need a stable var for confirm modal date:
    let confirmDate = null;
    const _openConfirmModal = openConfirmModal;
    openConfirmModal = (ds) => {
      confirmDate = ds;
      _openConfirmModal(ds);
    };

    if (els.confirmDone) {
      els.confirmDone.addEventListener("click", async () => {
        if (!confirmDate) return;
        const timeText = (els.confirmInput?.value || "").trim();
        closeConfirmModal();

        try {
          // confirm date for that month; keep block flag independent; keep time text even if later unconfirmed
          await setConfirmedForMonth(confirmDate, true, timeText);
        } catch (e) {
          console.error(e);
          alert("Could not confirm date (RLS?).");
        }
      });
    }
  }

  init();
})();
