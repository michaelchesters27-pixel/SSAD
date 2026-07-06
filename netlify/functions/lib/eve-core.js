const { getSupabase } = require("./supabase");

const DEFAULT_MARKETS = [
  { symbol: "EUR/USD", display_name: "Euro / Dollar", asset_class: "forex", enabled: true, scan_priority: 1 },
  { symbol: "GBP/USD", display_name: "Pound / Dollar", asset_class: "forex", enabled: true, scan_priority: 2 },
  { symbol: "AUD/USD", display_name: "Aussie / Dollar", asset_class: "forex", enabled: true, scan_priority: 3 },
  { symbol: "USD/JPY", display_name: "Dollar / Yen", asset_class: "forex", enabled: true, scan_priority: 4 },
  { symbol: "USD/CAD", display_name: "Dollar / Cad", asset_class: "forex", enabled: true, scan_priority: 5 },
  { symbol: "EUR/JPY", display_name: "Euro / Yen", asset_class: "forex", enabled: true, scan_priority: 6 },
  { symbol: "GBP/JPY", display_name: "Pound / Yen", asset_class: "forex", enabled: true, scan_priority: 7 },
  { symbol: "XAU/USD", display_name: "Gold", asset_class: "metal", enabled: true, scan_priority: 8 },
  { symbol: "BTC/USD", display_name: "Bitcoin", asset_class: "crypto", enabled: true, scan_priority: 9 }
];

const ALLOWED_SCAN_SYMBOLS = new Set(DEFAULT_MARKETS.map((m) => m.symbol));

const INTERVALS = [
  { key: "h1", td: "1h", outputsize: 220 },
  { key: "m15", td: "15min", outputsize: 220 },
  { key: "m5", td: "5min", outputsize: 220 }
];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : 0));
}

function round(n, dp = 2) {
  const p = Math.pow(10, dp);
  return Math.round((Number(n) || 0) * p) / p;
}

function mean(arr) {
  const clean = arr.filter(Number.isFinite);
  if (!clean.length) return 0;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function median(arr) {
  const clean = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = mean(values.slice(0, period));
  for (let i = 0; i < values.length; i += 1) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (i === period - 1) {
      out.push(prev);
      continue;
    }
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function atr(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i += 1) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trs.length < period) return [];
  const out = [];
  let prev = mean(trs.slice(0, period));
  for (let i = 0; i < trs.length; i += 1) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (i === period - 1) {
      out.push(prev);
      continue;
    }
    prev = (prev * (period - 1) + trs[i]) / period;
    out.push(prev);
  }
  return [null, ...out];
}

function parseTwelveDataValues(payload) {
  if (!payload) return [];
  if (payload.status === "error") {
    throw new Error(payload.message || payload.code || "Twelve Data returned an error.");
  }
  if (!Array.isArray(payload.values)) return [];

  return payload.values
    .map((v) => ({
      datetime: v.datetime,
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: v.volume === undefined ? null : Number(v.volume)
    }))
    .filter((v) => v.datetime && [v.open, v.high, v.low, v.close].every(Number.isFinite))
    .reverse();
}

function dateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const obj = {};
  for (const p of parts) obj[p.type] = p.value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: obj.weekday,
    dayOfWeek: weekdays[obj.weekday],
    year: Number(obj.year),
    month: Number(obj.month),
    day: Number(obj.day),
    hour: Number(obj.hour),
    minute: Number(obj.minute),
    second: Number(obj.second)
  };
}

function marketOpenInfo(market, now = new Date()) {
  const ny = dateParts(now, "America/New_York");
  const london = dateParts(now, "Europe/London");
  const minutesNY = ny.hour * 60 + ny.minute;
  const minutesLondon = london.hour * 60 + london.minute;

  if (market.asset_class === "crypto") {
    return { is_open: true, mode: "crypto_24_7", reason: "Crypto open 24/7", session_score: sessionScore(market, minutesLondon) };
  }

  if (market.asset_class === "forex") {
    const open =
      (ny.dayOfWeek === 0 && minutesNY >= 17 * 60 + 5) ||
      (ny.dayOfWeek >= 1 && ny.dayOfWeek <= 4) ||
      (ny.dayOfWeek === 5 && minutesNY <= 16 * 60 + 55);

    return {
      is_open: open,
      mode: open ? "weekday" : "closed",
      reason: open ? "Forex market open" : "Forex market closed",
      session_score: open ? sessionScore(market, minutesLondon) : 0
    };
  }

  if (market.asset_class === "metal") {
    const broadlyOpen =
      (ny.dayOfWeek === 0 && minutesNY >= 18 * 60 + 5) ||
      (ny.dayOfWeek >= 1 && ny.dayOfWeek <= 4) ||
      (ny.dayOfWeek === 5 && minutesNY <= 16 * 60 + 55);
    const dailyBreak = ny.dayOfWeek >= 1 && ny.dayOfWeek <= 5 && minutesNY >= 16 * 60 + 55 && minutesNY < 18 * 60 + 5;
    const open = broadlyOpen && !dailyBreak;

    return {
      is_open: open,
      mode: open ? "weekday" : "closed",
      reason: open ? "Metal market open" : "Metal market closed / daily break",
      session_score: open ? sessionScore(market, minutesLondon) : 0
    };
  }

  return { is_open: false, mode: "closed", reason: "Unknown market type", session_score: 0 };
}

function sessionScore(market, londonMinutes) {
  const hour = Math.floor(londonMinutes / 60);
  if (market.asset_class === "crypto") {
    if (hour >= 12 && hour <= 22) return 85;
    if (hour >= 7 && hour < 12) return 75;
    return 65;
  }
  if (market.asset_class === "metal") {
    if (hour >= 12 && hour <= 21) return 100;
    if (hour >= 7 && hour < 12) return 85;
    if (hour >= 22 || hour < 1) return 55;
    return 45;
  }
  if (market.asset_class === "forex") {
    if (hour >= 7 && hour < 12) return 95;
    if (hour >= 12 && hour <= 17) return 100;
    if (hour >= 18 && hour <= 21) return 65;
    if (hour >= 23 || hour < 6) return 45;
    return 60;
  }
  return 50;
}

function timeframeMs(intervalKey) {
  if (intervalKey === "m5") return 5 * 60 * 1000;
  if (intervalKey === "m15") return 15 * 60 * 1000;
  if (intervalKey === "h1") return 60 * 60 * 1000;
  return 5 * 60 * 1000;
}

function parseCandleDate(candleDatetime) {
  // Twelve Data returns exchange-local timestamps without timezone. Treat them as UTC for freshness safety.
  // If a market is open but the candle is stale, EVE excludes it instead of trusting old Friday data.
  const s = String(candleDatetime || "").replace(" ", "T");
  const d = new Date(s.endsWith("Z") ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isFresh(candleDatetime, intervalKey, now = new Date()) {
  const d = parseCandleDate(candleDatetime);
  if (!d) return false;
  const maxAge = intervalKey === "m5" ? 20 * 60 * 1000 : timeframeMs(intervalKey) * 3;
  return now.getTime() - d.getTime() <= maxAge;
}

function analyseTimeframe(candles) {
  if (!Array.isArray(candles) || candles.length < 60) {
    return { ok: false, score: 0, trend: "mixed", reason: "Not enough candle data" };
  }

  const closes = candles.map((c) => c.close);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const atr14 = atr(candles, 14);

  const i = candles.length - 1;
  const close = closes[i];
  const e50 = ema50[i];
  const e200 = ema200[i];
  const e50Past = ema50[Math.max(0, i - 10)];
  const e200Past = ema200[Math.max(0, i - 10)];
  const atrNow = atr14[i] || mean(atr14.slice(-20).filter(Boolean)) || Math.abs(close * 0.001);
  const atrSafe = atrNow || 1;
  const change20 = close - closes[Math.max(0, i - 20)];

  let score = 0;
  if (e50 && close > e50) score += 18;
  if (e50 && close < e50) score -= 18;
  if (e200 && close > e200) score += 16;
  if (e200 && close < e200) score -= 16;
  if (e50 && e200 && e50 > e200) score += 16;
  if (e50 && e200 && e50 < e200) score -= 16;

  const e50Slope = e50 && e50Past ? (e50 - e50Past) / atrSafe : 0;
  const e200Slope = e200 && e200Past ? (e200 - e200Past) / atrSafe : 0;
  score += clamp(e50Slope * 20, -18, 18);
  score += clamp(e200Slope * 20, -10, 10);
  score += clamp((change20 / atrSafe) * 8, -22, 22);

  score = clamp(score, -100, 100);

  let trend = "mixed";
  if (score >= 20) trend = "bullish";
  if (score <= -20) trend = "bearish";

  return {
    ok: true,
    score: round(score, 2),
    trend,
    latest_close: close,
    ema50: e50 ? round(e50, 5) : null,
    ema200: e200 ? round(e200, 5) : null,
    atr: round(atrSafe, 6)
  };
}

function analyseM5(candles, bias) {
  if (!Array.isArray(candles) || candles.length < 60) {
    return {
      momentum_score: 0,
      volatility_score: 0,
      cleanliness_score: 0,
      chop_label: "unknown"
    };
  }

  const closes = candles.map((c) => c.close);
  const atr14 = atr(candles, 14).filter(Number.isFinite);
  const latestAtr = atr14[atr14.length - 1] || 0;
  const medianAtr = median(atr14.slice(-80)) || latestAtr || 1;
  const recent = candles.slice(-8);
  const last20 = candles.slice(-21);

  let biasDir = 0;
  if (bias === "bullish") biasDir = 1;
  if (bias === "bearish") biasDir = -1;
  if (biasDir === 0) {
    const recentStart = closes[Math.max(0, closes.length - 9)] || closes[0];
    biasDir = closes[closes.length - 1] >= recentStart ? 1 : -1;
  }

  const bodyScores = recent.map((c) => {
    const range = Math.max(c.high - c.low, 0.0000001);
    const body = c.close - c.open;
    const closeLocation = (c.close - c.low) / range;
    const bodyStrength = Math.abs(body) / range;
    const dir = body >= 0 ? 1 : -1;
    const directionAligned = dir === biasDir ? 1 : -1;
    const closeQuality = biasDir === 1 ? closeLocation : 1 - closeLocation;
    return directionAligned * bodyStrength * 65 + closeQuality * 35;
  });

  const momentumRaw = mean(bodyScores);
  const momentumScore = clamp(50 + momentumRaw / 2, 0, 100);

  const recentAtrRatio = latestAtr / (medianAtr || latestAtr || 1);
  const volatilityScore = clamp(50 + (recentAtrRatio - 1) * 55, 15, 100);

  let travel = 0;
  for (let i = 1; i < last20.length; i += 1) travel += Math.abs(last20[i].close - last20[i - 1].close);
  const net = Math.abs(last20[last20.length - 1].close - last20[0].close);
  const efficiency = travel ? net / travel : 0;

  let alternations = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1].close - recent[i - 1].open;
    const curr = recent[i].close - recent[i].open;
    if (prev && curr && Math.sign(prev) !== Math.sign(curr)) alternations += 1;
  }

  const wickRatios = recent.map((c) => {
    const range = Math.max(c.high - c.low, 0.0000001);
    const body = Math.abs(c.close - c.open);
    return 1 - body / range;
  });
  const wickPenalty = mean(wickRatios);
  const alternationPenalty = alternations / Math.max(1, recent.length - 1);

  const cleanlinessScore = clamp(efficiency * 100 - wickPenalty * 25 - alternationPenalty * 25 + 20, 0, 100);
  const chopLabel = cleanlinessScore >= 70 ? "clean" : cleanlinessScore >= 45 ? "mixed" : "choppy";

  return {
    momentum_score: round(momentumScore, 2),
    volatility_score: round(volatilityScore, 2),
    cleanliness_score: round(cleanlinessScore, 2),
    chop_label: chopLabel,
    efficiency: round(efficiency, 3),
    atr_ratio: round(recentAtrRatio, 3)
  };
}

function scoreMarket(market, candlesByTf, openInfo, now = new Date()) {
  if (!openInfo.is_open) {
    return {
      symbol: market.symbol,
      display_name: market.display_name,
      asset_class: market.asset_class,
      is_open: false,
      is_stale: false,
      bias: "closed",
      bias_score: 0,
      score: 0,
      status: "Closed",
      reason: openInfo.reason,
      session_score: 0,
      latest_candle_at: null,
      latest_price: null,
      raw: { openInfo }
    };
  }

  const h1 = analyseTimeframe(candlesByTf.h1 || []);
  const m15 = analyseTimeframe(candlesByTf.m15 || []);
  const m5 = analyseTimeframe(candlesByTf.m5 || []);
  const latestM5 = candlesByTf.m5?.[candlesByTf.m5.length - 1];
  const fresh = latestM5 && isFresh(latestM5.datetime, "m5", now);

  if (!fresh) {
    return {
      symbol: market.symbol,
      display_name: market.display_name,
      asset_class: market.asset_class,
      is_open: false,
      is_stale: true,
      bias: "stale",
      bias_score: 0,
      score: 0,
      status: "Stale / excluded",
      reason: "Latest M5 candle is stale, so EVE excluded this market from ranking.",
      h1_score: h1.score || 0,
      m15_score: m15.score || 0,
      m5_score: m5.score || 0,
      session_score: 0,
      latest_candle_at: latestM5?.datetime || null,
      latest_price: latestM5?.close || null,
      raw: { h1, m15, m5, openInfo }
    };
  }

  const biasScore = clamp((h1.score || 0) * 0.30 + (m15.score || 0) * 0.50 + (m5.score || 0) * 0.20, -100, 100);

  // Stricter bias rule for EVE:
  // M15 is the main decision timeframe. EVE only prints bullish/bearish when
  // M15 agrees with either H1 or M5. Weak/one-timeframe pressure stays mixed.
  let bias = "mixed";
  const m15BullishWithAgreement = m15.trend === "bullish" && (h1.trend === "bullish" || m5.trend === "bullish");
  const m15BearishWithAgreement = m15.trend === "bearish" && (h1.trend === "bearish" || m5.trend === "bearish");
  if (m15BullishWithAgreement && biasScore >= 15) bias = "bullish";
  if (m15BearishWithAgreement && biasScore <= -15) bias = "bearish";

  const m5Detail = analyseM5(candlesByTf.m5 || [], bias);
  const directionAgreement = bias === "mixed" ? 0 : [h1, m15, m5].filter((r) => r.trend === bias).length;
  const alignmentScore = bias === "mixed" ? 28 : clamp(Math.abs(biasScore) * 0.75 + directionAgreement * 16, 0, 100);

  let score =
    alignmentScore * 0.35 +
    m5Detail.momentum_score * 0.25 +
    m5Detail.cleanliness_score * 0.20 +
    m5Detail.volatility_score * 0.15 +
    openInfo.session_score * 0.05;

  if (bias === "mixed") score = Math.min(score, 64);
  if (m5Detail.chop_label === "choppy") score = Math.min(score, 58);
  score = clamp(score, 0, 100);

  let status = "Avoid";
  if (score >= 85) status = "Best now";
  else if (score >= 75) status = "Strong watch";
  else if (score >= 65) status = "Good watch";
  else if (score >= 55) status = "Watch only";

  const biasText = bias === "bullish" ? "bullish" : bias === "bearish" ? "bearish" : "mixed";
  const reasonBits = [];
  reasonBits.push(`H1 ${h1.trend || "mixed"}`);
  reasonBits.push(`M15 ${m15.trend || "mixed"}`);
  reasonBits.push(`M5 ${m5.trend || "mixed"}`);
  reasonBits.push(`M5 ${m5Detail.chop_label}`);
  reasonBits.push(`volatility ${m5Detail.volatility_score >= 65 ? "active" : m5Detail.volatility_score >= 45 ? "normal" : "quiet"}`);

  return {
    symbol: market.symbol,
    display_name: market.display_name,
    asset_class: market.asset_class,
    is_open: true,
    is_stale: false,
    bias,
    bias_score: round(biasScore, 2),
    score: round(score, 2),
    status,
    reason: `${biasText.toUpperCase()} pressure: ${reasonBits.join(", ")}.`,
    h1_score: round(h1.score || 0, 2),
    m15_score: round(m15.score || 0, 2),
    m5_score: round(m5.score || 0, 2),
    momentum_score: m5Detail.momentum_score,
    volatility_score: m5Detail.volatility_score,
    cleanliness_score: m5Detail.cleanliness_score,
    session_score: openInfo.session_score,
    latest_candle_at: latestM5?.datetime || null,
    latest_price: latestM5?.close || null,
    raw: { h1, m15, m5, m5Detail, openInfo }
  };
}

async function fetchCandles(symbol, interval, outputsize) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) throw new Error("TWELVEDATA_API_KEY is not set in Netlify environment variables.");

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(outputsize));
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("format", "JSON");
  url.searchParams.set("timezone", "UTC");

  const exchange = process.env.TWELVEDATA_EXCHANGE;
  if (exchange) url.searchParams.set("exchange", exchange);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status} for ${symbol} ${interval}`);
  const payload = await res.json();
  return parseTwelveDataValues(payload);
}

async function loadSettings(sb) {
  const { data, error } = await sb.from("eve_settings").select("key,value,updated_at");
  if (error) throw error;
  const settings = {};
  for (const row of data || []) settings[row.key] = row.value;
  if (settings.scanner_enabled === undefined) settings.scanner_enabled = true;
  return settings;
}

async function setScannerEnabled(enabled, changedBy = "admin") {
  const sb = getSupabase();
  const { error } = await sb.from("eve_settings").upsert({
    key: "scanner_enabled",
    value: Boolean(enabled),
    updated_at: new Date().toISOString(),
    changed_by: changedBy
  });
  if (error) throw error;
  return Boolean(enabled);
}

async function loadMarkets(sb) {
  const { data, error } = await sb
    .from("eve_markets")
    .select("symbol,display_name,asset_class,enabled,scan_priority")
    .eq("enabled", true)
    .order("scan_priority", { ascending: true });

  if (error) throw error;
  if (!data || !data.length) return DEFAULT_MARKETS;

  // Safety filter: even if old rows remain enabled in Supabase,
  // this scanner only burns Twelve Data calls on the approved reduced list.
  const filtered = data.filter((m) => ALLOWED_SCAN_SYMBOLS.has(m.symbol));
  return filtered.length ? filtered : DEFAULT_MARKETS;
}


const SCHEDULED_SCAN_LOCK_MINUTES = Number(process.env.SCHEDULED_SCAN_LOCK_MINUTES || 4);

async function skipIfRecentScheduledRun(sb, tableName, currentRunId, startedAt, source, force) {
  if (source !== "scheduled" || force) return null;

  const lockMinutes = Number.isFinite(SCHEDULED_SCAN_LOCK_MINUTES) && SCHEDULED_SCAN_LOCK_MINUTES > 0
    ? SCHEDULED_SCAN_LOCK_MINUTES
    : 4;
  const cutoffIso = new Date(startedAt.getTime() - lockMinutes * 60 * 1000).toISOString();
  const startedIso = startedAt.toISOString();

  const { data: recentRun, error } = await sb
    .from(tableName)
    .select("id,started_at,completed_at,mode,source")
    .neq("id", currentRunId)
    .eq("source", "scheduled")
    .gte("started_at", cutoffIso)
    .lt("started_at", startedIso)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!recentRun) return null;

  const completedAt = new Date();
  const notes = `Scheduled scan skipped: another scheduled run already started at ${recentRun.started_at} within the last ${lockMinutes} minutes. No Twelve Data calls made.`;

  const { error: updateError } = await sb.from(tableName).update({
    completed_at: completedAt.toISOString(),
    mode: "skipped_recent_run",
    markets_requested: 0,
    markets_scanned: 0,
    markets_open: 0,
    errors: [],
    notes
  }).eq("id", currentRunId);
  if (updateError) throw updateError;

  return {
    ok: true,
    skipped: true,
    scan_id: currentRunId,
    mode: "skipped_recent_run",
    reason: "recent_scheduled_run",
    recent_scan_id: recentRun.id,
    recent_started_at: recentRun.started_at,
    lock_minutes: lockMinutes,
    message: notes,
    started_at: startedIso,
    completed_at: completedAt.toISOString()
  };
}

async function runScan({ source = "scheduled", force = false } = {}) {
  const startedAt = new Date();
  const sb = getSupabase();
  const settings = await loadSettings(sb);
  const scannerEnabled = settings.scanner_enabled !== false;

  let runId = null;
  const runInsert = await sb
    .from("eve_scan_runs")
    .insert({
      started_at: startedAt.toISOString(),
      mode: scannerEnabled ? "starting" : "scanner_off",
      scanner_enabled: scannerEnabled,
      source,
      markets_requested: 0,
      markets_scanned: 0,
      markets_open: 0,
      errors: []
    })
    .select("id")
    .single();

  if (runInsert.error) throw runInsert.error;
  runId = runInsert.data.id;

  const recentRunSkip = await skipIfRecentScheduledRun(sb, "eve_scan_runs", runId, startedAt, source, force);
  if (recentRunSkip) return recentRunSkip;

  if (!scannerEnabled && !force) {
    await sb.from("eve_scan_runs").update({
      completed_at: new Date().toISOString(),
      mode: "scanner_off",
      notes: "Scanner is OFF. No Twelve Data calls made."
    }).eq("id", runId);

    return {
      ok: true,
      scan_id: runId,
      mode: "scanner_off",
      scanner_enabled: false,
      markets: [],
      message: "Scanner is OFF. No Twelve Data calls made."
    };
  }

  const markets = await loadMarkets(sb);
  const now = new Date();
  const openInfos = markets.map((m) => ({ market: m, openInfo: marketOpenInfo(m, now) }));
  const openMarkets = openInfos.filter((x) => x.openInfo.is_open);
  const cryptoOnly = openMarkets.length > 0 && openMarkets.every((x) => x.market.asset_class === "crypto");
  const mode = cryptoOnly ? "weekend_crypto_only" : "weekday";
  const results = [];
  const errors = [];

  for (const { market, openInfo } of openInfos) {
    try {
      if (!openInfo.is_open) {
        results.push(scoreMarket(market, {}, openInfo, now));
        continue;
      }

      const candlesByTf = {};
      for (const tf of INTERVALS) {
        candlesByTf[tf.key] = await fetchCandles(market.symbol, tf.td, tf.outputsize);
      }

      results.push(scoreMarket(market, candlesByTf, openInfo, now));
    } catch (err) {
      errors.push({ symbol: market.symbol, message: err.message || String(err) });
      results.push({
        symbol: market.symbol,
        display_name: market.display_name,
        asset_class: market.asset_class,
        is_open: false,
        is_stale: true,
        bias: "error",
        bias_score: 0,
        score: 0,
        status: "Error / excluded",
        reason: err.message || "Data error",
        session_score: 0,
        latest_candle_at: null,
        latest_price: null,
        raw: { error: err.message || String(err), openInfo }
      });
    }
  }

  const rankable = results.filter((r) => r.is_open && !r.is_stale && !["closed", "error", "stale"].includes(r.bias));
  rankable.sort((a, b) => b.score - a.score);
  rankable.forEach((r, i) => { r.rank = i + 1; });
  const top = rankable[0] || null;

  const rows = results.map((r) => ({
    scan_id: runId,
    symbol: r.symbol,
    display_name: r.display_name,
    asset_class: r.asset_class,
    is_open: r.is_open,
    is_stale: Boolean(r.is_stale),
    rank: r.rank || null,
    bias: r.bias,
    bias_score: r.bias_score || 0,
    score: r.score || 0,
    status: r.status,
    reason: r.reason,
    h1_score: r.h1_score || null,
    m15_score: r.m15_score || null,
    m5_score: r.m5_score || null,
    momentum_score: r.momentum_score || null,
    volatility_score: r.volatility_score || null,
    cleanliness_score: r.cleanliness_score || null,
    session_score: r.session_score || null,
    latest_candle_at: r.latest_candle_at || null,
    latest_price: r.latest_price || null,
    raw: r.raw || {}
  }));

  if (rows.length) {
    const { error: insertScoresError } = await sb.from("eve_market_scores").insert(rows);
    if (insertScoresError) throw insertScoresError;
    await checkPriceAlarms(sb, rows);
  }

  const completedAt = new Date();
  const { error: updateRunError } = await sb.from("eve_scan_runs").update({
    completed_at: completedAt.toISOString(),
    mode,
    scanner_enabled: scannerEnabled,
    markets_requested: markets.length,
    markets_scanned: openMarkets.length,
    markets_open: rankable.length,
    top_symbol: top?.symbol || null,
    errors,
    notes: errors.length ? "Scan completed with one or more market errors." : "Scan completed."
  }).eq("id", runId);

  if (updateRunError) throw updateRunError;

  return {
    ok: true,
    scan_id: runId,
    mode,
    scanner_enabled: scannerEnabled,
    markets_requested: markets.length,
    markets_scanned: openMarkets.length,
    markets_open: rankable.length,
    top_symbol: top?.symbol || null,
    errors,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString()
  };
}

function nextFiveMinuteIso(from = new Date()) {
  const d = new Date(from.getTime());
  d.setUTCSeconds(0, 0);
  const m = d.getUTCMinutes();
  const add = 5 - (m % 5 || 5);
  d.setUTCMinutes(m + add);
  return d.toISOString();
}

async function getLatestResults() {
  const sb = getSupabase();
  const settings = await loadSettings(sb);

  const { data: run, error: runError } = await sb
    .from("eve_scan_runs")
    .select("id,started_at,completed_at,mode,scanner_enabled,markets_requested,markets_scanned,markets_open,top_symbol,source,notes,errors")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runError) throw runError;

  let scores = [];
  if (run?.id) {
    const { data, error } = await sb
      .from("eve_market_scores")
      .select("symbol,display_name,asset_class,is_open,is_stale,rank,bias,bias_score,score,status,reason,h1_score,m15_score,m5_score,momentum_score,volatility_score,cleanliness_score,session_score,latest_candle_at,latest_price,created_at")
      .eq("scan_id", run.id)
      .order("rank", { ascending: true, nullsFirst: false })
      .order("score", { ascending: false });

    if (error) throw error;
    scores = data || [];
  }

  const now = new Date();
  const markets = await loadMarkets(sb);
  const liveOpenStatus = markets.map((market) => ({
    symbol: market.symbol,
    is_open_now: marketOpenInfo(market, now).is_open,
    asset_class: market.asset_class
  }));

  const top = scores.find((s) => s.rank === 1) || null;
  const leaders = {
    forex: scores.filter((s) => s.asset_class === "forex" && s.is_open).sort((a, b) => (a.rank || 999) - (b.rank || 999))[0] || null,
    metal: scores.filter((s) => s.asset_class === "metal" && s.is_open).sort((a, b) => (a.rank || 999) - (b.rank || 999))[0] || null,
    crypto: scores.filter((s) => s.asset_class === "crypto" && s.is_open).sort((a, b) => (a.rank || 999) - (b.rank || 999))[0] || null
  };

  const price_alarms = await loadPriceAlarms(sb);

  return {
    ok: true,
    generated_at: now.toISOString(),
    next_scan_at: nextFiveMinuteIso(now),
    scanner_enabled: settings.scanner_enabled !== false,
    latest_run: run || null,
    markets: scores,
    top,
    leaders,
    price_alarms,
    live_open_status: liveOpenStatus
  };
}


async function getLatestPriceForSymbol(sb, symbol) {
  const { data, error } = await sb
    .from("eve_market_scores")
    .select("latest_price,created_at")
    .eq("symbol", symbol)
    .not("latest_price", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Number(data?.latest_price) || null;
}

async function loadPriceAlarms(sb = getSupabase()) {
  const { data, error } = await sb
    .from("eve_price_alarms")
    .select("id,symbol,target_price,trigger_direction,is_active,is_triggered,triggered_at,acknowledged_at,last_checked_price,last_checked_at,created_at,updated_at,label")
    .order("is_triggered", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    // Allows the dashboard to still load if the user has not run the new alarm SQL yet.
    if (String(error.message || "").toLowerCase().includes("eve_price_alarms")) return [];
    throw error;
  }
  return data || [];
}

async function createPriceAlarm({ symbol, target_price, trigger_direction = "auto", label = null }) {
  const sb = getSupabase();
  const target = Number(target_price);
  if (!symbol) throw new Error("Market symbol is required.");
  if (!Number.isFinite(target) || target <= 0) throw new Error("Valid target price is required.");

  const markets = await loadMarkets(sb);
  const market = markets.find((m) => m.symbol === symbol);
  if (!market) throw new Error(`Unknown or disabled market: ${symbol}`);

  const latestPrice = await getLatestPriceForSymbol(sb, symbol);
  let direction = String(trigger_direction || "auto").toLowerCase();
  if (direction === "auto") {
    direction = latestPrice !== null && target < latestPrice ? "below" : "above";
  }
  if (!["above", "below"].includes(direction)) {
    throw new Error("Alarm direction must be above, below or auto.");
  }

  const { data, error } = await sb
    .from("eve_price_alarms")
    .insert({
      symbol,
      target_price: target,
      trigger_direction: direction,
      is_active: true,
      is_triggered: false,
      triggered_at: null,
      acknowledged_at: null,
      last_checked_price: latestPrice,
      last_checked_at: latestPrice === null ? null : new Date().toISOString(),
      label
    })
    .select("id,symbol,target_price,trigger_direction,is_active,is_triggered,last_checked_price,created_at,label")
    .single();

  if (error) throw error;
  return data;
}

async function deletePriceAlarm(id) {
  const sb = getSupabase();
  if (!id) throw new Error("Alarm id is required.");
  const { error } = await sb.from("eve_price_alarms").delete().eq("id", id);
  if (error) throw error;
  return true;
}

async function acknowledgePriceAlarm(id) {
  const sb = getSupabase();
  if (!id) throw new Error("Alarm id is required.");
  const { data, error } = await sb
    .from("eve_price_alarms")
    .update({
      is_active: false,
      acknowledged_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .select("id,symbol,target_price,trigger_direction,is_triggered,acknowledged_at")
    .single();
  if (error) throw error;
  return data;
}

async function acknowledgeAllTriggeredAlarms() {
  const sb = getSupabase();
  const { error } = await sb
    .from("eve_price_alarms")
    .update({
      is_active: false,
      acknowledged_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("is_triggered", true)
    .is("acknowledged_at", null);
  if (error) throw error;
  return true;
}

async function checkPriceAlarms(sb, scoreRows) {
  const rowsWithPrices = (scoreRows || []).filter((r) => Number.isFinite(Number(r.latest_price)) && r.is_open && !r.is_stale);
  if (!rowsWithPrices.length) return { checked: 0, triggered: 0 };

  const symbols = [...new Set(rowsWithPrices.map((r) => r.symbol))];
  const { data: alarms, error } = await sb
    .from("eve_price_alarms")
    .select("id,symbol,target_price,trigger_direction,last_checked_price")
    .eq("is_active", true)
    .eq("is_triggered", false)
    .in("symbol", symbols);

  if (error) {
    // Do not break EVE scanning if the alarm table has not been created yet.
    if (String(error.message || "").toLowerCase().includes("eve_price_alarms")) return { checked: 0, triggered: 0 };
    throw error;
  }

  if (!alarms || !alarms.length) return { checked: 0, triggered: 0 };

  const priceBySymbol = new Map(rowsWithPrices.map((r) => [r.symbol, Number(r.latest_price)]));
  const nowIso = new Date().toISOString();
  let triggered = 0;

  for (const alarm of alarms) {
    const current = priceBySymbol.get(alarm.symbol);
    if (!Number.isFinite(current)) continue;
    const target = Number(alarm.target_price);
    const direction = alarm.trigger_direction;
    const hit = direction === "above" ? current >= target : current <= target;

    const update = {
      last_checked_price: current,
      last_checked_at: nowIso,
      updated_at: nowIso
    };

    if (hit) {
      update.is_triggered = true;
      update.is_active = false;
      update.triggered_at = nowIso;
      triggered += 1;
    }

    const { error: updateError } = await sb.from("eve_price_alarms").update(update).eq("id", alarm.id);
    if (updateError) throw updateError;
  }

  return { checked: alarms.length, triggered };
}

module.exports = {
  DEFAULT_MARKETS,
  runScan,
  getLatestResults,
  setScannerEnabled,
  createPriceAlarm,
  deletePriceAlarm,
  acknowledgePriceAlarm,
  acknowledgeAllTriggeredAlarms,
  loadPriceAlarms,
  marketOpenInfo,
  nextFiveMinuteIso
};
