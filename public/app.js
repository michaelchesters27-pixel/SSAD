const state = {
  data: null,
  loading: false,
  adminPassword: localStorage.getItem("eve_admin_password") || "",
  alarmSoundEnabled: localStorage.getItem("eve_alarm_sound_enabled") === "true",
  playedAlarmIds: new Set()
};

const $ = (id) => document.getElementById(id);

function fmtTime(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(d);
}

function fmtDateTime(iso) {
  if (!iso) return "waiting for first result";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "waiting for first result";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(d);
}

function showToast(msg) {
  const toast = $("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.add("hidden"), 4200);
}

function badgeClass(bias) {
  if (bias === "bullish") return "bias-bullish";
  if (bias === "bearish") return "bias-bearish";
  return "bias-mixed";
}

function trendFromScore(score) {
  const n = Number(score || 0);
  if (n >= 20) return "bullish";
  if (n <= -20) return "bearish";
  return "mixed";
}

function shortTrendLabel(trend) {
  if (trend === "bullish") return "BULL";
  if (trend === "bearish") return "BEAR";
  return "MIX";
}

function tfPill(label, score) {
  const trend = trendFromScore(score);
  return `<span class="tf-pill ${trend}">${label} ${shortTrendLabel(trend)}</span>`;
}


function setClock() {
  $("ukClock").textContent = fmtTime(new Date().toISOString());
}

function modeLabel(mode) {
  if (!mode) return "Waiting";
  if (mode === "weekend_crypto_only") return "Weekend: Crypto Only";
  if (mode === "scanner_off") return "Scanner Off";
  if (mode === "weekday") return "Weekday Markets";
  return mode.replaceAll("_", " ");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.adminPassword ? { "x-eve-admin-password": state.adminPassword } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

async function loadLatest() {
  if (state.loading) return;
  state.loading = true;
  try {
    const data = await api("/.netlify/functions/latest-results");
    state.data = data;
    render(data);
  } catch (err) {
    showToast(err.message || "Could not load EVE results");
  } finally {
    state.loading = false;
  }
}

function render(data) {
  const run = data.latest_run;
  const scannerEnabled = data.scanner_enabled !== false;
  $("scannerState").textContent = scannerEnabled ? "ON" : "OFF";
  $("marketMode").textContent = modeLabel(run?.mode);
  $("nextScan").textContent = fmtTime(data.next_scan_at);
  $("lastScan").textContent = `Last scan: ${fmtDateTime(run?.completed_at || run?.started_at)}`;
  $("openCount").textContent = `Markets open: ${run?.markets_open ?? 0} / ${run?.markets_requested ?? 12}`;
  $("coreStatus").textContent = scannerEnabled ? "SCANNING" : "PAUSED";
  $("toggleBtn").textContent = scannerEnabled ? "Turn Scanner Off" : "Turn Scanner On";
  $("soundBtn").textContent = state.alarmSoundEnabled ? "Alarm Sound Enabled" : "Enable Alarm Sound";

  renderTop(data.top);
  renderLeaders(data);
  renderGrid(data.markets || [], data.price_alarms || []);
  renderAlarmPanel(data.price_alarms || []);
  renderTable(data.markets || []);
  handleTriggeredAlarms(data.price_alarms || []);
}

function renderTop(top) {
  const empty = $("topPickEmpty");
  const content = $("topPickContent");
  if (!top) {
    empty.classList.remove("hidden");
    content.classList.add("hidden");
    return;
  }

  empty.classList.add("hidden");
  content.classList.remove("hidden");
  $("topSymbol").textContent = top.symbol;
  $("topScore").textContent = Math.round(Number(top.score || 0));
  $("topReason").textContent = top.reason || "No reason saved.";
  const topBias = $("topBias");
  topBias.textContent = `${top.bias || "mixed"} • ${top.status || "watch"}`;
  topBias.className = `bias-pill ${badgeClass(top.bias)}`;
}

function renderLeader(elId, label) {
  const el = $(elId);
  const strong = el.querySelector("strong");
  const small = el.querySelector("small");
  if (!label) {
    strong.textContent = "--";
    small.textContent = "No open market";
    return;
  }
  strong.textContent = label.symbol;
  small.textContent = `${Math.round(label.score || 0)}% • ${label.bias} • ${label.status}`;
}

function renderLeaders(data) {
  renderLeader("leaderForex", data.leaders?.forex);
  renderLeader("leaderMetal", data.leaders?.metal);
  renderLeader("leaderCrypto", data.leaders?.crypto);

  const open = (data.markets || []).filter((m) => m.is_open && !m.is_stale);
  const worst = open.sort((a, b) => Number(a.cleanliness_score || 100) - Number(b.cleanliness_score || 100))[0];
  const card = $("avoidCard");
  card.querySelector("strong").textContent = worst ? worst.symbol : "--";
  card.querySelector("small").textContent = worst ? `Cleanliness ${Math.round(worst.cleanliness_score || 0)}%` : "No open market";
}

function latestAlarmForSymbol(alarms, symbol) {
  return alarms.find((a) => a.symbol === symbol && !a.acknowledged_at) || null;
}

function renderGrid(markets, alarms) {
  const grid = $("marketGrid");
  if (!markets.length) {
    grid.innerHTML = `<div class="market-card"><div class="market-symbol">No scan yet</div><p class="card-reason">Run a manual scan after your Netlify variables and Supabase SQL are set.</p></div>`;
    return;
  }

  grid.innerHTML = markets.map((m) => {
    const score = Math.round(Number(m.score || 0));
    const bias = m.bias || "mixed";
    const classes = ["market-card", bias];
    if (!m.is_open || m.is_stale) classes.push("closed");
    if (m.rank === 1) classes.push("best");
    if (Number(m.cleanliness_score || 100) < 45 && m.is_open) classes.push("choppy");

    const rank = m.rank ? `#${m.rank}` : (m.is_open ? "OPEN" : "CLOSED");
    const reason = m.reason || m.status || "No reason saved.";
    const alarm = latestAlarmForSymbol(alarms, m.symbol);
    const alarmText = alarm
      ? `${alarm.is_triggered ? "ALARM HIT" : "Alarm"} ${alarm.trigger_direction} ${formatPrice(alarm.target_price, m.symbol)}`
      : "Set Alarm";

    return `
      <article class="${classes.join(" ")}">
        <div class="market-meta"><span>${rank}</span><span>${m.asset_class}</span></div>
        <div class="market-symbol">${m.symbol}</div>
        <div class="price-row">Latest: <strong>${formatPrice(m.latest_price, m.symbol)}</strong></div>
        <div class="bias-pill ${badgeClass(bias)}">${bias} • ${m.status || "watch"}</div>
        <div class="tf-stack">${tfPill("H1", m.h1_score)}${tfPill("M15", m.m15_score)}${tfPill("M5", m.m5_score)}</div>
        <div class="market-line">
          <div class="pulse-meter"><div style="width:${score}%"></div></div>
          <div class="score-mini">${score}%</div>
        </div>
        <p class="card-reason">${escapeHtml(reason)}</p>
        <button class="alarm-btn ${alarm?.is_triggered ? "alarm-hit" : ""}" data-symbol="${m.symbol}" data-price="${m.latest_price || ""}">${escapeHtml(alarmText)}</button>
      </article>
    `;
  }).join("");
}

function renderAlarmPanel(alarms) {
  const list = $("alarmList");
  if (!alarms.length) {
    list.innerHTML = `<div class="alarm-empty">No price alarms set.</div>`;
    return;
  }

  list.innerHTML = alarms.map((a) => {
    const stateText = a.acknowledged_at ? "Acknowledged" : a.is_triggered ? "Triggered" : a.is_active ? "Active" : "Inactive";
    const classes = ["alarm-item"];
    if (a.is_triggered && !a.acknowledged_at) classes.push("triggered");
    return `
      <div class="${classes.join(" ")}">
        <div>
          <strong>${a.symbol}</strong>
          <span>${stateText} • ${a.trigger_direction} ${formatPrice(a.target_price, a.symbol)}</span>
          <small>Last checked: ${formatPrice(a.last_checked_price, a.symbol)} ${a.last_checked_at ? `at ${fmtTime(a.last_checked_at)}` : ""}</small>
        </div>
        <div class="alarm-actions">
          ${a.is_triggered && !a.acknowledged_at ? `<button class="ghost-btn ack-alarm" data-id="${a.id}">Acknowledge</button>` : ""}
          <button class="ghost-btn delete-alarm" data-id="${a.id}">Delete</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderTable(markets) {
  const body = $("rankingBody");
  if (!markets.length) {
    body.innerHTML = `<tr><td colspan="8">No scans saved yet.</td></tr>`;
    return;
  }

  body.innerHTML = markets.map((m) => {
    const rank = m.rank || "—";
    const score = Math.round(Number(m.score || 0));
    const bias = m.bias || "mixed";
    return `
      <tr>
        <td>${rank}</td>
        <td><strong>${m.symbol}</strong><br><small>${m.display_name || ""}</small></td>
        <td>${m.asset_class}</td>
        <td><span class="bias-pill ${badgeClass(bias)}">${bias}</span></td>
        <td>${score}%</td>
        <td>${formatPrice(m.latest_price, m.symbol)}</td>
        <td>${m.status || "—"}</td>
        <td>${escapeHtml(m.reason || "—")}</td>
      </tr>
    `;
  }).join("");
}

function formatPrice(value, symbol = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  let dp = 5;
  if (symbol.includes("JPY")) dp = 3;
  if (symbol.startsWith("XAU")) dp = 2;
  if (["BTC/USD"].includes(symbol)) dp = 2;
  return n.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function askPassword() {
  const value = prompt("Enter EVE admin password");
  if (value) {
    state.adminPassword = value.trim();
    localStorage.setItem("eve_admin_password", state.adminPassword);
    showToast("Admin password saved in this browser.");
  }
}

async function toggleScanner() {
  if (!state.adminPassword) askPassword();
  if (!state.adminPassword) return;

  const current = state.data?.scanner_enabled !== false;
  const next = !current;
  $("toggleBtn").disabled = true;
  try {
    const result = await api("/.netlify/functions/toggle-scanner", {
      method: "POST",
      body: JSON.stringify({ enabled: next })
    });
    showToast(result.message || "Scanner updated");
    await loadLatest();
  } catch (err) {
    showToast(err.message || "Could not toggle scanner");
  } finally {
    $("toggleBtn").disabled = false;
  }
}

async function manualScan() {
  if (!state.adminPassword) askPassword();
  if (!state.adminPassword) return;

  $("manualScanBtn").disabled = true;
  showToast("Manual scan started. This can take a moment...");
  try {
    const result = await api("/.netlify/functions/manual-scan", { method: "POST", body: JSON.stringify({}) });
    showToast(result.top_symbol ? `Scan complete. Top market: ${result.top_symbol}` : "Scan complete.");
    await loadLatest();
  } catch (err) {
    showToast(err.message || "Manual scan failed");
  } finally {
    $("manualScanBtn").disabled = false;
  }
}

async function setPriceAlarm(symbol, latestPrice) {
  if (!state.adminPassword) askPassword();
  if (!state.adminPassword) return;

  const current = Number(latestPrice);
  const currentText = Number.isFinite(current) ? ` Current price: ${formatPrice(current, symbol)}.` : "";
  const targetRaw = prompt(`Set price alarm for ${symbol}.${currentText}\n\nEnter target price:`);
  if (!targetRaw) return;
  const target = Number(String(targetRaw).replaceAll(",", ""));
  if (!Number.isFinite(target) || target <= 0) {
    showToast("Enter a valid price.");
    return;
  }

  let direction = "auto";
  if (Number.isFinite(current)) {
    direction = target < current ? "below" : "above";
  }

  try {
    const result = await api("/.netlify/functions/price-alarms", {
      method: "POST",
      body: JSON.stringify({ action: "create", symbol, target_price: target, trigger_direction: direction })
    });
    const alarm = result.alarm;
    showToast(`${alarm.symbol} alarm set: ${alarm.trigger_direction} ${formatPrice(alarm.target_price, alarm.symbol)}`);
    await loadLatest();
  } catch (err) {
    showToast(err.message || "Could not set alarm");
  }
}

async function deleteAlarm(id) {
  if (!state.adminPassword) askPassword();
  if (!state.adminPassword) return;
  try {
    await api("/.netlify/functions/price-alarms", {
      method: "POST",
      body: JSON.stringify({ action: "delete", id })
    });
    showToast("Alarm deleted");
    await loadLatest();
  } catch (err) {
    showToast(err.message || "Could not delete alarm");
  }
}

async function acknowledgeAlarm(id) {
  if (!state.adminPassword) askPassword();
  if (!state.adminPassword) return;
  try {
    await api("/.netlify/functions/price-alarms", {
      method: "POST",
      body: JSON.stringify({ action: "acknowledge", id })
    });
    showToast("Alarm acknowledged");
    await loadLatest();
  } catch (err) {
    showToast(err.message || "Could not acknowledge alarm");
  }
}

async function acknowledgeAllAlarms() {
  if (!state.adminPassword) askPassword();
  if (!state.adminPassword) return;
  try {
    await api("/.netlify/functions/price-alarms", {
      method: "POST",
      body: JSON.stringify({ action: "acknowledge_all" })
    });
    hideAlarmBanner();
    showToast("Triggered alarms acknowledged");
    await loadLatest();
  } catch (err) {
    showToast(err.message || "Could not acknowledge alarms");
  }
}

function enableAlarmSound() {
  state.alarmSoundEnabled = true;
  localStorage.setItem("eve_alarm_sound_enabled", "true");
  $("soundBtn").textContent = "Alarm Sound Enabled";
  playAlarmSound(true);
  showToast("Alarm sound enabled.");
}

function playAlarmSound(short = false) {
  if (!state.alarmSoundEnabled) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const ctx = playAlarmSound.ctx || new AudioContext();
  playAlarmSound.ctx = ctx;
  if (ctx.state === "suspended") ctx.resume();

  const repeats = short ? 1 : 4;
  for (let i = 0; i < repeats; i += 1) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = i % 2 ? 720 : 520;
    gain.gain.setValueAtTime(0.001, ctx.currentTime + i * 0.28);
    gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + i * 0.28 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.28 + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + i * 0.28);
    osc.stop(ctx.currentTime + i * 0.28 + 0.2);
  }
}

function handleTriggeredAlarms(alarms) {
  const triggered = alarms.filter((a) => a.is_triggered && !a.acknowledged_at);
  if (!triggered.length) {
    hideAlarmBanner();
    return;
  }

  const newest = triggered[0];
  $("alarmTitle").textContent = `${newest.symbol} PRICE ALARM`;
  $("alarmText").textContent = `Hit ${newest.trigger_direction} ${formatPrice(newest.target_price, newest.symbol)}`;
  $("alarmBanner").classList.remove("hidden");

  for (const alarm of triggered) {
    if (!state.playedAlarmIds.has(alarm.id)) {
      state.playedAlarmIds.add(alarm.id);
      playAlarmSound(false);
    }
  }
}

function hideAlarmBanner() {
  $("alarmBanner").classList.add("hidden");
}

$("toggleBtn").addEventListener("click", toggleScanner);
$("manualScanBtn").addEventListener("click", manualScan);
$("passwordBtn").addEventListener("click", askPassword);
$("refreshBtn").addEventListener("click", loadLatest);
$("soundBtn").addEventListener("click", enableAlarmSound);
$("ackAllBtn").addEventListener("click", acknowledgeAllAlarms);
$("ackBannerBtn").addEventListener("click", acknowledgeAllAlarms);

document.addEventListener("click", (event) => {
  const alarmBtn = event.target.closest(".alarm-btn");
  if (alarmBtn) {
    setPriceAlarm(alarmBtn.dataset.symbol, alarmBtn.dataset.price);
    return;
  }

  const deleteBtn = event.target.closest(".delete-alarm");
  if (deleteBtn) {
    deleteAlarm(deleteBtn.dataset.id);
    return;
  }

  const ackBtn = event.target.closest(".ack-alarm");
  if (ackBtn) {
    acknowledgeAlarm(ackBtn.dataset.id);
  }
});

setClock();
setInterval(setClock, 1000);
loadLatest();
setInterval(loadLatest, 30000);
