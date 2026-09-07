/**
 * Glue: fetch de datos en vivo (Binance API pública, símbolo PAXGUSDT como
 * proxy 1:1 de oro físico), pipeline de análisis ICT/SMC, render del chart
 * y del panel de señales, polling y log persistente en localStorage.
 */

const SYMBOL = 'PAXGUSDT';
const HTF_INTERVAL = '1h';
const ALL_TFS = ['1m', '5m', '15m', '1h', '4h'];
const SWING_LOOKBACK = { '1m': 2, '5m': 2, '15m': 2, '1h': 3, '4h': 4 };
const TF_LABEL = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H' };
const CANDLE_LIMIT = 300;
const REFRESH_MS = 5000; // más rápido = precio/distancia a la zona más al día; las zonas en sí solo cambian al cerrar una vela nueva
const LOG_KEY = 'xauusd_signal_log_v1';
const PREFS_KEY = 'xauusd_prefs_v1';

let currentLTF = '15m';
let chart, lastPrice = null, prevPrice = null;
let currentPlan = null;
let nextRefreshAt = Date.now() + REFRESH_MS;
const liveBtn = document.getElementById('liveBtn');

const statusDot = document.getElementById('statusDot');
const lastUpdateEl = document.getElementById('lastUpdate');
const nextRefreshEl = document.getElementById('nextRefresh');
const livePriceEl = document.getElementById('livePrice');
const priceChangeEl = document.getElementById('priceChange');

function sessionOf(timeSeconds) {
  const h = new Date(timeSeconds * 1000).getUTCHours();
  if (h >= 13 && h < 21) return 'NY';
  if (h >= 8 && h < 13) return 'Londres';
  return 'Asia';
}

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
}
function savePrefs(p) { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); }

async function fetchKlines(interval, limit = CANDLE_LIMIT, symbol = SYMBOL) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const raw = await res.json();
  return raw.map(k => ({
    time: Math.floor(k[0] / 1000),
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
  }));
}

async function fetchKlinesResilient(interval, limit = CANDLE_LIMIT, retries = 2, symbol = SYMBOL) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchKlines(interval, limit, symbol);
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
}

function loadLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; }
}
function saveLog(log) {
  localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-200)));
}

function runPipeline(candles, swingLookback) {
  const swings = ICT.detectSwings(candles, swingLookback);
  const structure = ICT.analyzeStructure(candles, swings);
  const obs = ICT.detectOrderBlocks(candles, structure.events);
  const fvgs = ICT.detectFVGs(candles);
  const sr = ICT.detectSRLevels(swings);
  const liquidity = ICT.detectLiquidity(swings);
  const pd = ICT.premiumDiscount(swings, candles[candles.length - 1].close);
  const sweeps = ICT.detectLiquiditySweep(candles, liquidity);
  return { swings, structure, obs, fvgs, sr, liquidity, pd, sweeps };
}

function fmt(n) {
  return n == null || isNaN(n) ? '-' : n.toFixed(2);
}

// ---------- Alertas (sonido + notificación del navegador) ----------
let audioCtx = null;
function playAlertSound(signal) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const freqs = signal === 'BUY' ? [660, 880] : [440, 330];
    freqs.forEach((f, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, now + i * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.2, now + i * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 0.15);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.16);
      osc.stop(now + i * 0.16 + 0.16);
    });
  } catch (e) { /* audio no disponible */ }
}

function notifyBrowser(signalResult) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = signalResult.signal === 'BUY' ? '🟢 XAUUSD — Señal de COMPRA' : '🔴 XAUUSD — Señal de VENTA';
  new Notification(title, {
    body: `Precio ${fmt(signalResult.price)} · Confianza ${signalResult.confidence}% · TF ${currentLTF}`,
  });
}

// ---------- Webhooks (Discord / Telegram) — el usuario aporta su propia URL/token ----------
async function sendDiscordWebhook(url, content) {
  if (!url) return false;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
    return res.ok;
  } catch (e) { console.warn('Discord webhook falló (posible bloqueo CORS):', e); return false; }
}
async function sendTelegramMessage(token, chatId, text) {
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    return res.ok;
  } catch (e) { console.warn('Telegram falló:', e); return false; }
}

function fireAlerts(signalResult, plan) {
  const prefs = loadPrefs();
  if (prefs.sound) playAlertSound(signalResult.signal);
  if (prefs.notify) notifyBrowser(signalResult);
  if (prefs.discordEnabled || prefs.telegramEnabled) {
    const text = plan ? buildPlanText(signalResult, plan) : `XAUUSD — ${signalResult.signal} (${currentLTF}) a ${fmt(signalResult.price)}`;
    if (prefs.discordEnabled) sendDiscordWebhook(prefs.discordWebhookUrl, text);
    if (prefs.telegramEnabled) sendTelegramMessage(prefs.telegramBotToken, prefs.telegramChatId, text);
  }
}

function wireWebhooks() {
  const prefs = loadPrefs();
  const discordCb = document.getElementById('tg-discord');
  const telegramCb = document.getElementById('tg-telegram');
  const discordUrl = document.getElementById('discordWebhookUrl');
  const tgToken = document.getElementById('telegramBotToken');
  const tgChatId = document.getElementById('telegramChatId');

  discordCb.checked = !!prefs.discordEnabled;
  telegramCb.checked = !!prefs.telegramEnabled;
  if (prefs.discordWebhookUrl) discordUrl.value = prefs.discordWebhookUrl;
  if (prefs.telegramBotToken) tgToken.value = prefs.telegramBotToken;
  if (prefs.telegramChatId) tgChatId.value = prefs.telegramChatId;

  const persist = () => savePrefs({
    ...loadPrefs(),
    discordEnabled: discordCb.checked, discordWebhookUrl: discordUrl.value.trim(),
    telegramEnabled: telegramCb.checked, telegramBotToken: tgToken.value.trim(), telegramChatId: tgChatId.value.trim()
  });
  [discordCb, telegramCb, discordUrl, tgToken, tgChatId].forEach(el => el.addEventListener('change', persist));

  document.getElementById('testDiscordBtn').addEventListener('click', async () => {
    const btn = document.getElementById('testDiscordBtn');
    persist();
    btn.textContent = 'Enviando…';
    const ok = await sendDiscordWebhook(discordUrl.value.trim(), '✅ Prueba desde el Panel de Señales XAUUSD — si ves este mensaje, el webhook funciona.');
    btn.textContent = ok ? '✅ Enviado' : '❌ Falló'; setTimeout(() => { btn.textContent = 'Probar'; }, 2200);
  });
  document.getElementById('testTelegramBtn').addEventListener('click', async () => {
    const btn = document.getElementById('testTelegramBtn');
    persist();
    btn.textContent = 'Enviando…';
    const ok = await sendTelegramMessage(tgToken.value.trim(), tgChatId.value.trim(), '✅ Prueba desde el Panel de Señales XAUUSD — si ves este mensaje, el bot funciona.');
    btn.textContent = ok ? '✅ Enviado' : '❌ Falló'; setTimeout(() => { btn.textContent = 'Probar'; }, 2200);
  });
}

// ---------- Calculadora de tamaño de posición ----------
function updatePositionCalc() {
  const resultEl = document.getElementById('calcResult');
  const balance = parseFloat(document.getElementById('calcBalance').value) || 0;
  const riskPct = parseFloat(document.getElementById('calcRisk').value) || 0;
  savePrefs({ ...loadPrefs(), balance, riskPct });

  if (!currentPlan || balance <= 0 || riskPct <= 0) {
    resultEl.innerHTML = 'Sin señal activa — no hay SL para calcular.';
    return;
  }
  const riskAmount = balance * (riskPct / 100);
  const distance = Math.abs(currentPlan.entry - currentPlan.sl);
  if (distance <= 0) { resultEl.innerHTML = 'Distancia a SL inválida.'; return; }
  const sizeOz = riskAmount / distance;
  const sizeLots = sizeOz / 100; // 1 lote estándar de oro ≈ 100 oz (varía según bróker)
  resultEl.innerHTML = `
    Riesgo: <b>$${riskAmount.toFixed(2)}</b> (${riskPct}% de $${balance.toFixed(2)})<br>
    Distancia a SL: <b>${distance.toFixed(2)}</b> pts<br>
    Tamaño sugerido: <b>${sizeOz.toFixed(2)} oz</b> (~${sizeLots.toFixed(3)} lotes est.)<br>
    <span style="font-size:10px;">*Referencia — 1 lote estándar ≈ 100 oz, verifica el tamaño de contrato de tu bróker.</span>
  `;
}

// ---------- Copiar plan al portapapeles ----------
function buildPlanText(signalResult, plan) {
  const dir = signalResult.signal === 'BUY' ? 'COMPRA' : 'VENTA';
  return [
    `XAUUSD — Señal de ${dir} (${currentLTF}, confianza ${signalResult.confidence}%)`,
    `Entry Zone: ${fmt(plan.entryZone[0])} - ${fmt(plan.entryZone[1])}`,
    `Invalid Level (SL): ${fmt(plan.sl)}`,
    `TP1: ${fmt(plan.tp1)} (R:R ${plan.rr1})`,
    `TP2: ${fmt(plan.tp2)} (R:R ${plan.rr2})`,
    `TP3: ${fmt(plan.tp3)} (R:R ${plan.rr3})`
  ].join('\n');
}

function wireCopyButton() {
  const btn = document.getElementById('copyPlanBtn');
  btn.addEventListener('click', async () => {
    if (!currentPlan) return;
    const text = buildPlanText(window.__lastSignal, currentPlan);
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '✅ Copiado';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '📋 Copiar plan'; btn.classList.remove('copied'); }, 1800);
    } catch (e) { /* portapapeles no disponible */ }
  });
}

function wireShareButton() {
  const btn = document.getElementById('sharePlanBtn');
  btn.addEventListener('click', async () => {
    if (!currentPlan) return;
    const text = buildPlanText(window.__lastSignal, currentPlan);
    if (navigator.share) {
      try { await navigator.share({ title: 'Señal XAUUSD', text }); } catch (e) { /* usuario canceló */ }
    } else {
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '✅ Copiado';
        setTimeout(() => { btn.textContent = '📤 Compartir'; }, 1800);
      } catch (e) { /* nada disponible */ }
    }
  });
}

// ---------- Sincronizar configuración + historial entre dispositivos ----------
function exportFullConfig() {
  const data = { prefs: loadPrefs(), log: loadLog(), exportedAt: new Date().toISOString(), version: 1 };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `xauusd_config_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function importFullConfig(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.prefs) savePrefs(data.prefs);
      if (data.log) saveLog(data.log);
      alert('Configuración importada correctamente. La página se recargará para aplicarla.');
      location.reload();
    } catch (e) {
      alert('El archivo no es una configuración válida de esta página.');
    }
  };
  reader.readAsText(file);
}
function wireSync() {
  document.getElementById('exportConfigBtn').addEventListener('click', exportFullConfig);
  const fileInput = document.getElementById('importConfigFile');
  document.getElementById('importConfigBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) importFullConfig(fileInput.files[0]);
    fileInput.value = '';
  });
}

function renderMtfBias(pipelines) {
  const el = document.getElementById('mtfBias');
  el.innerHTML = ALL_TFS.map(tf => {
    const trend = pipelines[tf].structure.trend;
    const dirClass = trend === 'bullish' ? 'bullish' : trend === 'bearish' ? 'bearish' : 'unknown';
    const dirText = trend === 'bullish' ? 'Alcista' : trend === 'bearish' ? 'Bajista' : 'Indef.';
    const arrow = trend === 'bullish' ? '↑' : trend === 'bearish' ? '↓' : '–';
    const active = tf === currentLTF ? ' active' : '';
    return `<div class="mtf-cell${active}" data-tf="${tf}" title="Clic para ver ${TF_LABEL[tf]}">
      <span class="mtf-tf">${TF_LABEL[tf]}</span>
      <span class="mtf-dir ${dirClass}">${arrow} ${dirText}</span>
    </div>`;
  }).join('');
  el.querySelectorAll('.mtf-cell').forEach(cell => cell.addEventListener('click', () => switchTimeframe(cell.dataset.tf)));
}

// Zona de entrada detallada: rango, origen (OB/FVG/ATR), ancho, estado en vivo
// (dentro/esperando) y una barra visual con la posición del precio actual.
function renderEntryZoneDetail(plan, currentPrice, atr) {
  const [zBottom, zTop] = plan.entryZone;
  const width = zTop - zBottom;
  const inside = currentPrice >= zBottom && currentPrice <= zTop;
  const distance = inside ? 0 : (currentPrice < zBottom ? zBottom - currentPrice : currentPrice - zTop);
  const distanceAtr = atr ? distance / atr : null;

  const lo = Math.min(zBottom, currentPrice);
  const hi = Math.max(zTop, currentPrice);
  const pad = (hi - lo) * 0.25 || Math.max(width, 1) * 0.5;
  const rangeMin = lo - pad, rangeMax = hi + pad;
  const pct = (v) => Math.min(100, Math.max(0, ((v - rangeMin) / (rangeMax - rangeMin)) * 100));

  const zoneLeftPct = pct(zBottom);
  const zoneWidthPct = Math.max(1, pct(zTop) - pct(zBottom));
  const pricePct = pct(currentPrice);
  const sourceLabel = { OB: 'Order Block', FVG: 'Fair Value Gap', ATR: 'Colchón ATR (genérico)' }[plan.entryZoneSource] || plan.entryZoneSource;

  return `
    <div class="entry-zone-detail ${inside ? 'inside' : ''} ${plan.direction === 'BUY' ? 'buy' : 'sell'}">
      <div class="entry-zone-head">
        <span class="tp-tag">ENTRY ZONE</span>
        <span class="ez-source">${sourceLabel}</span>
        <span class="ez-status">${inside ? '● EN ZONA AHORA' : 'esperando retroceso'}</span>
      </div>
      <div class="entry-zone-range"><b>${fmt(zBottom)} – ${fmt(zTop)}</b><span class="muted"> (ancho ${width.toFixed(2)} pts)</span></div>
      <div class="ez-bar-track">
        <div class="ez-bar-zone" style="left:${zoneLeftPct}%;width:${zoneWidthPct}%"></div>
        <div class="ez-bar-price" style="left:${pricePct}%"></div>
      </div>
      <div class="ez-bar-labels">
        <span>Precio actual: ${fmt(currentPrice)}</span>
        <span>${inside ? 'Dentro de la zona' : `Distancia: ${distance.toFixed(2)} pts${distanceAtr != null ? ' (' + distanceAtr.toFixed(1) + 'x ATR)' : ''}`}</span>
      </div>
    </div>
  `;
}

function renderSignalPanel(signalResult, plan, ltf) {
  currentPlan = plan;
  window.__lastSignal = signalResult;

  const badge = document.getElementById('signalBadge');
  const badgeText = signalResult.signal === 'BUY' ? 'COMPRA' : signalResult.signal === 'SELL' ? 'VENTA' : 'NEUTRAL';
  badge.innerHTML = signalResult.tier
    ? `${badgeText} <span class="tier-tag tier-${signalResult.tier.replace('+', 'plus')}">${signalResult.tier}</span>`
    : badgeText;
  badge.className = 'signal-badge ' + signalResult.signal;

  document.getElementById('confidenceFill').style.width = signalResult.confidence + '%';
  document.getElementById('confidenceText').textContent = signalResult.confidence + '%';

  const setupEl = document.getElementById('setupInfo');
  setupEl.innerHTML = signalResult.setup
    ? `<span class="setup-tag">SETUP ${signalResult.setup.code}</span><span class="setup-name">${signalResult.setup.name}</span><div class="setup-desc">${signalResult.setup.desc}</div>`
    : '';

  document.title = signalResult.signal === 'BUY' ? '🟢 COMPRA — XAUUSD'
    : signalResult.signal === 'SELL' ? '🔴 VENTA — XAUUSD'
    : 'XAUUSD · Panel de Señales';

  const copyBtn = document.getElementById('copyPlanBtn');
  copyBtn.disabled = !plan;
  document.getElementById('sharePlanBtn').disabled = !plan;

  const planEl = document.getElementById('tradePlan');
  if (plan) {
    planEl.innerHTML = `
      ${renderEntryZoneDetail(plan, lastPrice ?? plan.entry, ICT.computeATR(ltf.candles, 14))}
      <div class="tp-row sl"><span class="tp-tag">INVALID LEVEL</span><b>${fmt(plan.sl)}</b></div>
      <div class="tp-row tp"><span class="tp-tag">TP1</span><b>${fmt(plan.tp1)}</b><span class="rr">R:R ${plan.rr1}</span></div>
      <div class="tp-row tp"><span class="tp-tag">TP2</span><b>${fmt(plan.tp2)}</b><span class="rr">R:R ${plan.rr2}</span></div>
      <div class="tp-row tp"><span class="tp-tag">TP3</span><b>${fmt(plan.tp3)}</b><span class="rr">R:R ${plan.rr3}</span></div>
    `;
  } else {
    planEl.innerHTML = `<div style="text-align:center;color:var(--muted);padding:6px 0;">Sin plan — señal neutral, esperar confluencia</div>`;
  }
  updatePositionCalc();

  const reasonsEl = document.getElementById('reasonsList');
  reasonsEl.innerHTML = signalResult.reasons.length
    ? '<ul>' + signalResult.reasons.map(r => `<li>${r}</li>`).join('') + '</ul>'
    : '<div>Sin confluencias relevantes por ahora.</div>';

  document.getElementById('pdZone').textContent = ltf.pd ? (ltf.pd.zone === 'discount' ? 'Descuento' : 'Premium') : '-';
  document.getElementById('atrVal').textContent = fmt(ICT.computeATR(ltf.candles, 14));
}

const OUTCOME_BADGE = {
  tp1: '<span class="outcome-tag tp1">✅ TP1</span>',
  sl: '<span class="outcome-tag sl">❌ SL</span>',
  pending: '<span class="outcome-tag pending">⏳ Pendiente</span>',
  'n/a': '<span class="outcome-tag na">— </span>'
};

function logItemHtml(item) {
  const d = new Date(item.time * 1000);
  const ts = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `<div class="log-item">
    <span class="tag ${item.signal}">${item.signal}${item.tier ? ' ' + item.tier : ''}</span>
    <span class="meta">${item.tf || ''}</span>
    <span class="meta">${fmt(item.price)}</span>
    ${OUTCOME_BADGE[item.outcome] || OUTCOME_BADGE.pending}
    <span class="meta">${ts}</span>
  </div>`;
}

function renderLog(log) {
  const pendingEl = document.getElementById('signalLogPending');
  const resolvedEl = document.getElementById('signalLog');
  const statsEl = document.getElementById('logStats');

  const resolved = log.filter(i => i.outcome === 'tp1' || i.outcome === 'sl');
  const pending = log.filter(i => !i.outcome || i.outcome === 'pending');
  const wins = resolved.filter(i => i.outcome === 'tp1').length;
  statsEl.textContent = resolved.length
    ? `Precisión verificada: ${wins}/${resolved.length} (${Math.round((wins / resolved.length) * 100)}%) llegaron a TP1 antes que al SL`
    : 'Aún sin señales resueltas para medir precisión.';

  pendingEl.innerHTML = pending.length
    ? [...pending].reverse().map(logItemHtml).join('')
    : '<div style="color:var(--muted);font-size:12px;">Ninguna señal pendiente ahora mismo.</div>';

  resolvedEl.innerHTML = resolved.length
    ? [...resolved].reverse().map(logItemHtml).join('')
    : '<div style="color:var(--muted);font-size:12px;">Aún no hay señales resueltas.</div>';
}

function maybeLogSignal(signalResult, plan) {
  if (signalResult.signal === 'NEUTRAL') return;
  const log = loadLog();
  const last = log[log.length - 1];
  if (last && last.time === signalResult.time && last.signal === signalResult.signal && last.tf === currentLTF) return;
  log.push({
    time: signalResult.time, signal: signalResult.signal, price: signalResult.price,
    confidence: signalResult.confidence, tf: currentLTF, tier: signalResult.tier,
    entry: plan ? plan.entry : null, sl: plan ? plan.sl : null, tp1: plan ? plan.tp1 : null,
    outcome: 'pending', session: sessionOf(signalResult.time)
  });
  saveLog(log);
  fireAlerts(signalResult, plan);
  const isBuy = signalResult.signal === 'BUY';
  showToast(
    `<b>${isBuy ? '🟢 Nueva señal de COMPRA' : '🔴 Nueva señal de VENTA'}</b><span>${TF_LABEL[currentLTF]} · ${fmt(signalResult.price)} · ${signalResult.confidence}% ${signalResult.tier ? '· ' + signalResult.tier : ''}</span>`,
    isBuy ? 'buy' : 'sell'
  );
}

// Recorre el historial y marca cada señal como TP1 alcanzado, SL alcanzado o pendiente,
// comparando contra las velas reales que ya ocurrieron después de la señal.
function evaluateSignalOutcomes(pipelines) {
  const log = loadLog();
  let changed = false;
  for (const item of log) {
    if (item.outcome && item.outcome !== 'pending') continue;
    if (item.entry == null || item.sl == null || item.tp1 == null) { item.outcome = 'n/a'; changed = true; continue; }
    const pipeline = pipelines[item.tf];
    if (!pipeline) continue;
    const after = pipeline.candles.filter(c => c.time > item.time);
    for (const c of after) {
      if (item.signal === 'BUY') {
        if (c.low <= item.sl) { item.outcome = 'sl'; changed = true; break; }
        if (c.high >= item.tp1) { item.outcome = 'tp1'; changed = true; break; }
      } else {
        if (c.high >= item.sl) { item.outcome = 'sl'; changed = true; break; }
        if (c.low <= item.tp1) { item.outcome = 'tp1'; changed = true; break; }
      }
    }
  }
  if (changed) saveLog(log);
  return log;
}

// ---------- Guardia anti-sobreoperación: cooldown tras un SL reciente ----------
const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
function applyCooldown(signalResult, tf) {
  if (signalResult.signal === 'NEUTRAL') return signalResult;
  const cooldownCandles = 3;
  const cutoff = signalResult.time - cooldownCandles * (TF_SECONDS[tf] || 900);
  const log = loadLog();
  const recentSL = [...log].reverse().find(item => item.tf === tf && item.outcome === 'sl' && item.time > cutoff && item.time < signalResult.time);
  if (recentSL) {
    return {
      ...signalResult, signal: 'NEUTRAL', tier: null,
      reasons: [...signalResult.reasons, `⏸ En cooldown: la última señal de ${tf} terminó en SL hace menos de ${cooldownCandles} velas`]
    };
  }
  return signalResult;
}

function countSignalsToday(log, tf) {
  const todayStr = new Date().toISOString().slice(0, 10);
  return log.filter(item => item.tf === tf && new Date(item.time * 1000).toISOString().slice(0, 10) === todayStr).length;
}

// ---------- Aviso anticipado: "posible señal formándose" ----------
// No es una señal — es un heads-up de que el puntaje ya está cerca del umbral
// o de que una zona real ya fue tocada y solo falta la vela de confirmación.
// Nunca se registra en el historial ni cuenta como señal real.
let lastArmedKey = null;
function checkArmedState(signalResult, tf) {
  if (signalResult.signal !== 'NEUTRAL' || !signalResult.threshold) return null;
  const net = signalResult.bullScore - signalResult.bearScore;
  const absNet = Math.abs(net);
  const proximityPct = Math.min(99, Math.round((absNet / signalResult.threshold) * 100));
  const waitingConfirmation = signalResult.reasons.some(r => r.includes('esperando vela de confirmación'));
  if (proximityPct < 60 && !waitingConfirmation) return null;
  const direction = net >= 0 ? 'BUY' : 'SELL';
  return { direction, proximityPct: waitingConfirmation ? Math.max(proximityPct, 70) : proximityPct, tf };
}

function renderArmedBanner(armed) {
  const el = document.getElementById('armedBanner');
  if (!armed) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  el.className = 'armed-banner ' + armed.direction;
  el.innerHTML = `🔶 Posible señal <b>${armed.direction === 'BUY' ? 'de COMPRA' : 'de VENTA'}</b> formándose en ${TF_LABEL[armed.tf]} — ${armed.proximityPct}% del camino al umbral`;
}

function playArmedSound() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 520;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.22);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + 0.22);
  } catch (e) { /* audio no disponible */ }
}

function maybeFireArmedAlert(armed) {
  const key = armed ? `${armed.tf}_${armed.direction}` : null;
  if (key && key !== lastArmedKey) {
    const prefs = loadPrefs();
    if (prefs.sound) playArmedSound();
    if (prefs.notify && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('🔶 Posible señal formándose', { body: `${armed.direction} en ${TF_LABEL[armed.tf]} — ${armed.proximityPct}% del camino` });
    }
    showToast(
      `<b>🔶 Posible señal formándose</b><span>${armed.direction === 'BUY' ? 'Compra' : 'Venta'} en ${TF_LABEL[armed.tf]} — ${armed.proximityPct}% del camino</span>`,
      'armed', 5000
    );
  }
  lastArmedKey = key;
}

// ---------- Volatilidad + indicadores técnicos (confirmación) ----------
function renderVolatilityIndicators(candles) {
  const vol = IND.classifyVolatility(candles, 14);
  const badge = document.getElementById('volBadge');
  badge.textContent = `VOLATILIDAD: ${vol.level}`;
  badge.className = 'vol-badge ' + vol.level;
  document.getElementById('volDetail').textContent = vol.atr ? `ATR ${vol.atr.toFixed(2)} (${vol.ratio.toFixed(2)}x su promedio)` : '';

  const t = IND.technicalConfirmation(candles);
  const rows = [
    ['RSI (14)', t.rsi != null ? t.rsi.toFixed(1) : '-'],
    ['EMA9 / EMA20', (t.ema9 != null && t.ema20 != null) ? `${t.ema9.toFixed(2)} / ${t.ema20.toFixed(2)}` : '-'],
    ['EMA50 / EMA200', (t.ema50 != null && t.ema200 != null) ? `${t.ema50.toFixed(2)} / ${t.ema200.toFixed(2)}` : '-'],
    ['MACD hist.', t.macd.histogram != null ? t.macd.histogram.toFixed(3) : '-'],
    ['ADX (14)', t.adx != null ? t.adx.toFixed(1) : '-'],
    ['Bollinger (ancho)', t.bollinger ? t.bollinger.widthPct.toFixed(2) + '%' : '-']
  ];
  document.getElementById('indicatorsGrid').innerHTML = rows.map(([label, val]) =>
    `<div class="ind-row"><span>${label}</span><b>${val}</b></div>`
  ).join('');
  return { vol, technical: t };
}

// ---------- Estructura de mercado (HH/HL/LH/LL, interna vs externa) ----------
function renderStructurePanel(candles, swings, swingLookback) {
  const labeled = ICT.labelSwings(swings).slice(-10);
  document.getElementById('swingLabels').innerHTML = labeled.length
    ? labeled.map(s => `<span class="swing-tag ${s.label}">${s.label} ${s.price.toFixed(1)}</span>`).join('')
    : '<span class="muted">Sin swings suficientes todavía.</span>';

  const ie = ICT.internalExternalStructure(candles, swingLookback);
  const dirText = (t) => t === 'bullish' ? 'Alcista' : t === 'bearish' ? 'Bajista' : 'Indefinida';
  document.getElementById('structAlign').textContent = ie.aligned
    ? `Alineadas (${dirText(ie.external.trend)})`
    : `Interna ${dirText(ie.internal.trend)} / Externa ${dirText(ie.external.trend)}`;
}

// ---------- Motor de escenarios ----------
function renderScenarios(candles, swings) {
  const sc = ICT.buildScenarios(candles, swings);
  document.getElementById('scenarioBull').textContent = sc.bullishText;
  document.getElementById('scenarioNeutral').textContent = sc.neutralText;
  document.getElementById('scenarioBear').textContent = sc.bearishText;
}

// ---------- Checklist de la señal ----------
function renderChecklist(signalResult) {
  const el = document.getElementById('checklistList');
  el.innerHTML = (signalResult.checklist || []).map(item =>
    `<li class="${item.passed ? 'pass' : 'fail'}">${item.label}</li>`
  ).join('');
}

// ---------- Rendimiento real (a partir del historial verificado) ----------
let perfScope = 'tf'; // 'tf' = solo la temporalidad activa, 'all' = todas mezcladas (comparación explícita)
function renderPerformance(log) {
  const scoped = perfScope === 'tf' ? log.filter(i => i.tf === currentLTF) : log;
  const stats = BT.statsFromTrades(scoped);
  document.getElementById('perfGrid').innerHTML = perfRowsHtml(stats);
  document.getElementById('signalsToday').textContent = countSignalsToday(log, currentLTF);
  document.getElementById('perfScopeLabel').textContent = perfScope === 'tf' ? `(${TF_LABEL[currentLTF]} solamente)` : '(todas las temporalidades mezcladas)';
}
function wirePerfScopeToggle() {
  document.getElementById('scopeTfBtn').addEventListener('click', () => { perfScope = 'tf'; refreshScopeButtons(); renderPerformance(loadLog()); });
  document.getElementById('scopeAllBtn').addEventListener('click', () => { perfScope = 'all'; refreshScopeButtons(); renderPerformance(loadLog()); });
}
function refreshScopeButtons() {
  document.getElementById('scopeTfBtn').classList.toggle('active', perfScope === 'tf');
  document.getElementById('scopeAllBtn').classList.toggle('active', perfScope === 'all');
}
function perfRowsHtml(stats) {
  const pf = stats.profitFactor == null ? '-' : (stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2));
  return [
    ['Señales resueltas', stats.resolved],
    ['Win rate', stats.winRate != null ? stats.winRate.toFixed(0) + '%' : '-'],
    ['R promedio', stats.avgR != null ? stats.avgR.toFixed(2) + 'R' : '-'],
    ['Profit factor', pf],
    ['Racha ganadora máx.', stats.maxWinStreak],
    ['Racha perdedora máx.', stats.maxLossStreak]
  ].map(([label, val]) => `<div class="perf-row"><span>${label}</span><b>${val}</b></div>`).join('');
}

// ---------- Backtest rápido ----------
function wireBacktest() {
  document.getElementById('runBacktestBtn').addEventListener('click', () => {
    if (!window.__lastPipelines) return;
    const btn = document.getElementById('runBacktestBtn');
    btn.disabled = true;
    btn.textContent = 'Calculando…';
    setTimeout(() => {
      const { ltf, htf, bias4h } = window.__lastPipelines;
      const trades = BT.runQuickBacktest(ltf.candles, SWING_LOOKBACK[currentLTF] || 2, htf.structure, bias4h.structure);
      document.getElementById('backtestResult').innerHTML = perfRowsHtml(BT.statsFromTrades(trades)) +
        `<div class="perf-row" style="grid-column:1/-1;"><span>Señales simuladas</span><b>${trades.length}</b></div>`;
      btn.disabled = false;
      btn.textContent = '▶ Ejecutar backtest sobre este timeframe';
    }, 30);
  });
}

// ---------- Correlación con BTC (dato real de Binance, no inventado) ----------
function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const meanA = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const meanB = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) { cov += (a[i] - meanA) * (b[i] - meanB); varA += (a[i] - meanA) ** 2; varB += (b[i] - meanB) ** 2; }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}
function toReturns(candles) {
  const r = [];
  for (let i = 1; i < candles.length; i++) r.push((candles[i].close - candles[i - 1].close) / candles[i - 1].close);
  return r;
}
async function updateCorrelation(xauCandles1h) {
  const el = document.getElementById('corrBtc');
  try {
    const btcCandles = await fetchKlinesResilient('1h', 60, 1, 'BTCUSDT');
    const corr = pearsonCorrelation(toReturns(xauCandles1h.slice(-51)), toReturns(btcCandles.slice(-51)));
    if (corr == null) { el.textContent = 'DATO NO DISPONIBLE'; return; }
    const strength = Math.abs(corr) < 0.2 ? 'débil' : Math.abs(corr) < 0.5 ? 'moderada' : 'fuerte';
    el.textContent = `${corr.toFixed(2)} (${strength}, ${corr >= 0 ? 'positiva' : 'negativa'})`;
  } catch (e) {
    el.textContent = 'DATO NO DISPONIBLE';
  }
}

// ---------- Modo Básico / Profesional ----------
function wireModeToggle() {
  const btn = document.getElementById('modeToggleBtn');
  const advanced = document.getElementById('advancedSection');
  const secondary = document.querySelector('.secondary-panel');
  function apply(basic) {
    advanced.classList.toggle('hidden-basic', basic);
    if (secondary) secondary.style.display = basic ? 'none' : '';
    btn.textContent = basic ? '🔬 Modo Profesional' : '🎓 Modo Básico';
  }
  const savedBasic = !!loadPrefs().basicMode;
  apply(savedBasic);
  btn.addEventListener('click', () => {
    const nowBasic = !advanced.classList.contains('hidden-basic');
    apply(nowBasic);
    savePrefs({ ...loadPrefs(), basicMode: nowBasic });
  });
}

// ---------- Panel de Análisis Dinámico (segundo gráfico, seleccionable) ----------
let secondaryMode = 'heatmap';
const BREAKDOWN_LABELS = {
  trend: 'Tendencia 1H', structure: 'Estructura (BOS/CHoCH)', zone: 'Zona (OB/FVG)',
  srLevel: 'Soporte/Resistencia', premiumDiscount: 'Premium/Discount', liquidity: 'Liquidez',
  technical: 'Indicadores', keyLevel: 'Niveles Clave (PDH/PDL/Asia)'
};

function drawSecondaryPanel() {
  const canvas = document.getElementById('secondaryCanvas');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!rect.width || !rect.height) return;

  if (secondaryMode === 'heatmap') drawHeatmap(ctx, rect.width, rect.height);
  else if (secondaryMode === 'equity') drawEquityCurve(ctx, rect.width, rect.height);
  else drawStructureScoreChart(ctx, rect.width, rect.height);
}

function drawHeatmap(ctx, w, h) {
  const breakdown = window.__lastSignal && window.__lastSignal.breakdown;
  ctx.fillStyle = 'rgba(230,230,235,0.6)';
  ctx.font = '11px Segoe UI, sans-serif';
  if (!breakdown) { ctx.fillText('Sin datos de confluencia todavía.', 10, 20); return; }
  const keys = Object.keys(BREAKDOWN_LABELS);
  const rowH = h / keys.length;
  const centerX = w * 0.55;
  const maxVal = 3;
  keys.forEach((key, i) => {
    const y = i * rowH;
    const { bull, bear } = breakdown[key];
    ctx.fillStyle = 'rgba(230,230,235,0.75)';
    ctx.fillText(BREAKDOWN_LABELS[key], 8, y + rowH / 2 - 6);
    const barMaxW = centerX - 130;
    const bullW = Math.min(barMaxW, (bull / maxVal) * barMaxW);
    const bearW = Math.min(barMaxW, (bear / maxVal) * barMaxW);
    ctx.fillStyle = 'rgba(38,166,154,0.75)';
    ctx.fillRect(centerX - bullW, y + rowH / 2, bullW, 10);
    ctx.fillStyle = 'rgba(239,83,80,0.75)';
    ctx.fillRect(centerX, y + rowH / 2, bearW, 10);
    ctx.fillStyle = 'rgba(230,230,235,0.5)';
    ctx.fillText(bull.toFixed(1), centerX - barMaxW - 30, y + rowH / 2 + 9);
    ctx.fillText(bear.toFixed(1), centerX + barMaxW + 6, y + rowH / 2 + 9);
  });
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath(); ctx.moveTo(centerX, 0); ctx.lineTo(centerX, h); ctx.stroke();
}

function drawEquityCurve(ctx, w, h) {
  const log = loadLog();
  const resolved = log.filter(i => i.outcome === 'tp1' || i.outcome === 'sl');
  ctx.fillStyle = 'rgba(230,230,235,0.6)';
  ctx.font = '11px Segoe UI, sans-serif';
  if (resolved.length < 2) { ctx.fillText('Aún no hay suficientes señales resueltas para una curva de resultados.', 10, 20); return; }
  let cum = 0;
  const points = [0];
  for (const item of resolved) {
    const risk = Math.abs(item.entry - item.sl);
    const reward = Math.abs(item.tp1 - item.entry);
    cum += item.outcome === 'tp1' ? (risk ? reward / risk : 0) : -1;
    points.push(cum);
  }
  const margin = 30;
  const minV = Math.min(0, ...points), maxV = Math.max(0, ...points);
  const range = (maxV - minV) || 1;
  const stepX = (w - margin * 2) / (points.length - 1);
  const yFor = (v) => h - margin - ((v - minV) / range) * (h - margin * 2);

  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath(); ctx.moveTo(margin, yFor(0)); ctx.lineTo(w - margin, yFor(0)); ctx.stroke();

  ctx.strokeStyle = cum >= 0 ? '#26a69a' : '#ef5350';
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((v, i) => { const x = margin + i * stepX; if (i === 0) ctx.moveTo(x, yFor(v)); else ctx.lineTo(x, yFor(v)); });
  ctx.stroke();

  ctx.fillStyle = 'rgba(230,230,235,0.7)';
  ctx.fillText(`R acumulado: ${cum.toFixed(2)}R sobre ${resolved.length} señales resueltas`, margin, 16);
}

function drawStructureScoreChart(ctx, w, h) {
  const sig = window.__lastSignal;
  ctx.fillStyle = 'rgba(230,230,235,0.6)';
  ctx.font = '11px Segoe UI, sans-serif';
  if (!sig) { ctx.fillText('Sin datos todavía.', 10, 20); return; }
  const groups = [
    { label: 'HTF/Estructura', value: sig.breakdown.trend.bull + sig.breakdown.trend.bear + sig.breakdown.structure.bull + sig.breakdown.structure.bear, max: 5 },
    { label: 'Liquidez/Zona', value: sig.breakdown.zone.bull + sig.breakdown.zone.bear + sig.breakdown.liquidity.bull + sig.breakdown.liquidity.bear, max: 7 },
    { label: 'Niveles (S/R, PD, PDH/PDL)', value: sig.breakdown.srLevel.bull + sig.breakdown.srLevel.bear + sig.breakdown.premiumDiscount.bull + sig.breakdown.premiumDiscount.bear + sig.breakdown.keyLevel.bull + sig.breakdown.keyLevel.bear, max: 6.4 },
    { label: 'Indicadores', value: sig.breakdown.technical.bull + sig.breakdown.technical.bear, max: 1.3 }
  ];
  const barH = (h - 20) / groups.length;
  const maxBarW = w - 160;
  groups.forEach((g, i) => {
    const y = 10 + i * barH;
    const pct = Math.min(1, g.value / g.max);
    ctx.fillStyle = 'rgba(230,230,235,0.75)';
    ctx.fillText(g.label, 8, y + barH / 2 + 4);
    ctx.fillStyle = 'rgba(77,139,255,0.7)';
    ctx.fillRect(140, y + barH / 2 - 6, maxBarW * pct, 12);
    ctx.fillStyle = 'rgba(230,230,235,0.6)';
    ctx.fillText(`${Math.round(pct * 100)}%`, 140 + maxBarW * pct + 6, y + barH / 2 + 4);
  });
}

function wireSecondaryPanel() {
  const select = document.getElementById('secondarySelect');
  select.addEventListener('change', () => { secondaryMode = select.value; drawSecondaryPanel(); });
  window.addEventListener('resize', () => drawSecondaryPanel());
}

function updatePriceHeader(candles) {
  const last = candles[candles.length - 1];
  prevPrice = lastPrice;
  lastPrice = last.close;
  livePriceEl.textContent = fmt(lastPrice);
  const first = candles[Math.max(0, candles.length - 97)];
  const changePct = ((lastPrice - first.close) / first.close) * 100;
  priceChangeEl.textContent = `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% (24h aprox.)`;
  priceChangeEl.className = 'price-change ' + (changePct >= 0 ? 'up' : 'down');

  if (prevPrice != null && lastPrice !== prevPrice) {
    livePriceEl.classList.remove('flash-up', 'flash-down');
    void livePriceEl.offsetWidth; // fuerza reflow para poder re-disparar la animación
    livePriceEl.classList.add(lastPrice > prevPrice ? 'flash-up' : 'flash-down');
  }
}

// ---------- Notificaciones "toast" (nueva señal, avisos) ----------
function showToast(html, type = 'info', duration = 6000) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.innerHTML = html;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 260);
  }, duration);
}

// ---------- Onboarding: modal de bienvenida (una vez) + botón de ayuda ----------
function wireOnboarding() {
  const overlay = document.getElementById('onboardingOverlay');
  const open = () => { overlay.hidden = false; };
  const close = () => { overlay.hidden = true; localStorage.setItem('xauusd_onboarding_seen', '1'); };
  document.getElementById('onboardingCloseBtn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.getElementById('helpBtn').addEventListener('click', open);
  if (!localStorage.getItem('xauusd_onboarding_seen')) open();
}

// ---------- Escáner multi-timeframe: una señal por TF, reutilizando datos ya cargados ----------
function computeAllTfSignals(pipelines, keyLevels) {
  const htfStructure = pipelines[HTF_INTERVAL].structure;
  const biasStructure = pipelines['4h'].structure;
  const results = {};
  ALL_TFS.forEach(tf => {
    const p = pipelines[tf];
    const technical = IND.technicalConfirmation(p.candles);
    const volatility = IND.classifyVolatility(p.candles, 14);
    results[tf] = ICT.generateSignal({
      ltfCandles: p.candles, ltfStructure: p.structure, htfStructure, biasStructure,
      obs: p.obs, fvgs: p.fvgs, srLevels: p.sr, liquidity: p.liquidity, pd: p.pd, sweeps: p.sweeps,
      technical, volatility, keyLevels
    });
  });
  return results;
}

function renderOpportunities(allTfSignals) {
  const el = document.getElementById('opportunitiesList');
  const opportunities = ALL_TFS
    .map(tf => ({ tf, ...allTfSignals[tf] }))
    .filter(o => o.signal !== 'NEUTRAL')
    .sort((a, b) => b.confidence - a.confidence);

  if (!opportunities.length) {
    el.innerHTML = '<div class="opp-empty">Sin oportunidades claras en ninguna temporalidad ahora mismo.</div>';
    return;
  }
  el.innerHTML = opportunities.map((o, i) => `
    <div class="opp-row" data-tf="${o.tf}" title="Clic para ver ${TF_LABEL[o.tf]}">
      <span class="opp-tf">${TF_LABEL[o.tf]}</span>
      <span class="opp-sig ${o.signal}">${o.signal}${o.tier ? ' ' + o.tier : ''}</span>
      <span class="muted">${fmt(o.price)}</span>
      <span class="opp-conf">${o.confidence}% · ${o.confidenceLabel}</span>
    </div>
  `).join('');
  el.querySelectorAll('.opp-row').forEach(row => row.addEventListener('click', () => switchTimeframe(row.dataset.tf)));
}

// ---------- Reporte narrativo (plantilla determinística sobre datos reales, sin IA externa) ----------
function buildNarrative(signalResult, plan, ltf, htf, bias4h, vol, sessionLabel) {
  const dirWord = signalResult.signal === 'BUY' ? 'una compra' : signalResult.signal === 'SELL' ? 'una venta' : 'ninguna operación por ahora';
  const trendWord = (t) => t === 'bullish' ? 'alcista' : t === 'bearish' ? 'bajista' : 'indefinida';

  const p1 = `El mercado de XAUUSD (referencia PAXG/USDT) cotiza en ${fmt(signalResult.price)} durante la sesión de ${sessionLabel}, ` +
    `con una tendencia de 1H ${trendWord(htf.structure.trend)} y un sesgo de 4H ${trendWord(bias4h.structure.trend)}. ` +
    `La volatilidad actual se clasifica como ${vol.level} (ATR ${vol.atr.toFixed(2)}, ${vol.ratio.toFixed(2)}x su promedio reciente).`;

  const reasonsText = signalResult.reasons.length
    ? signalResult.reasons.map(r => r.replace(/^⚠ /, '')).join('; ') + '.'
    : 'no hay confluencias relevantes activas en este momento.';
  const p2 = `El motor de análisis recomienda ${dirWord} en ${TF_LABEL[currentLTF]}, con ${signalResult.confidence}% de confianza (${signalResult.confidenceLabel})` +
    `${signalResult.tier ? `, calidad de señal ${signalResult.tier}` : ''}. Las razones consideradas son: ${reasonsText}`;

  let p3;
  if (plan) {
    p3 = `Si se ejecutara, la zona de entrada sugerida es ${fmt(plan.entryZone[0])}–${fmt(plan.entryZone[1])}, con nivel inválido (SL) en ${fmt(plan.sl)} ` +
      `y objetivos en ${fmt(plan.tp1)} (R:R ${plan.rr1}), ${fmt(plan.tp2)} (R:R ${plan.rr2}) y ${fmt(plan.tp3)} (R:R ${plan.rr3}).`;
  } else {
    const failed = (signalResult.checklist || []).filter(c => !c.passed).map(c => c.label);
    p3 = failed.length
      ? `No hay plan de trade porque aún falta: ${failed.join('; ')}.`
      : `No hay plan de trade activo; el motor espera una confluencia más clara antes de sugerir una entrada.`;
  }

  return [p1, p2, p3].map(t => `<p>${t}</p>`).join('');
}

// ---------- Rendimiento por sesión y por calidad (tier) ----------
function renderBreakdownTable(elId, log, groupFn, labelFn, groups) {
  const el = document.getElementById(elId);
  el.innerHTML = groups.map(g => {
    const subset = log.filter(item => groupFn(item) === g);
    const stats = BT.statsFromTrades(subset);
    const wr = stats.winRate != null ? stats.winRate.toFixed(0) + '%' : '-';
    return `<div class="bd-row"><span>${labelFn(g)}</span><b>${wr} (${stats.resolved} señales)</b></div>`;
  }).join('');
}
function renderPerformanceBreakdowns(log) {
  renderBreakdownTable('perfBySession', log, i => i.session || sessionOf(i.time), s => s, ['Asia', 'Londres', 'NY']);
  renderBreakdownTable('perfByTier', log, i => i.tier || '-', t => t, ['A+', 'B', 'C']);
  renderTimeframePerformanceTable(log);
}

// Tabla animada de win rate / profit factor por temporalidad — todo real,
// calculado del historial verificado (nunca estimado ni inventado).
function renderTimeframePerformanceTable(log) {
  const el = document.getElementById('tfPerfTable');
  const rows = ALL_TFS.map(tf => {
    const subset = log.filter(i => i.tf === tf);
    const stats = BT.statsFromTrades(subset);
    return { tf, stats };
  }).filter(r => r.stats.resolved > 0)
    .sort((a, b) => (b.stats.winRate ?? -1) - (a.stats.winRate ?? -1)); // leaderboard: mejor win rate arriba

  if (!rows.length) {
    el.innerHTML = '<div class="tf-perf-empty">Aún no hay señales resueltas en ninguna temporalidad. Esta tabla se va a llenar sola a medida que las señales toquen TP1 o SL.</div>';
    return;
  }

  el.innerHTML = rows.map(({ tf, stats }, i) => {
    const wr = stats.winRate ?? 0;
    const pf = stats.profitFactor == null ? '-' : (stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2));
    const colorClass = wr >= 60 ? 'good' : wr >= 45 ? 'mid' : 'bad';
    const active = tf === currentLTF ? ' active' : '';
    const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
    return `
      <div class="tf-perf-row${active}" data-tf="${tf}" title="Clic para ver ${TF_LABEL[tf]}">
        <span class="tf-perf-rank">${rank}</span>
        <span class="tf-perf-tf">${TF_LABEL[tf]}</span>
        <div class="tf-perf-bar-track"><div class="tf-perf-bar-fill ${colorClass}" data-w="${wr}"></div></div>
        <span class="tf-perf-wr">${wr.toFixed(0)}%</span>
        <span class="tf-perf-meta">PF ${pf} · ${stats.resolved} señ.${stats.avgR != null ? ' · ' + stats.avgR.toFixed(2) + 'R prom.' : ''}</span>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.tf-perf-row').forEach(row => {
    row.addEventListener('click', () => switchTimeframe(row.dataset.tf));
  });

  // Anima el ancho después de insertar en el DOM (de 0% al valor real)
  requestAnimationFrame(() => {
    el.querySelectorAll('.tf-perf-bar-fill').forEach(bar => {
      requestAnimationFrame(() => { bar.style.width = bar.dataset.w + '%'; });
    });
  });
}

// ---------- Exportar historial como CSV ----------
function wireExportCsv() {
  document.getElementById('exportCsvBtn').addEventListener('click', () => {
    const log = loadLog();
    if (!log.length) return;
    const header = ['fecha', 'timeframe', 'señal', 'tier', 'confianza', 'precio', 'entry', 'sl', 'tp1', 'resultado', 'sesion'];
    const rows = log.map(i => [
      new Date(i.time * 1000).toISOString(), i.tf, i.signal, i.tier || '', i.confidence,
      i.price, i.entry ?? '', i.sl ?? '', i.tp1 ?? '', i.outcome || '', i.session || sessionOf(i.time)
    ]);
    const csv = [header, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xauusd_historial_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

// ---------- Calidad de datos (transparencia) ----------
function renderDataQuality(fetchMs) {
  const el = document.getElementById('dataQualityLine');
  el.textContent = `Fuente: Binance REST API (${SYMBOL}) · Latencia de la última consulta: ${fetchMs}ms · ` +
    `Hora de datos: ${new Date().toLocaleTimeString('es-ES')} · Datos macro (DXY/yields/calendario/noticias/COT): no disponibles, ver tarjeta de Contexto Macro.`;
}

async function refresh() {
  const fetchStarted = performance.now();
  try {
    const liveByTf = {};
    await Promise.all(ALL_TFS.map(async (tf) => {
      liveByTf[tf] = await fetchKlinesResilient(tf, CANDLE_LIMIT);
    }));
    const fetchMs = Math.round(performance.now() - fetchStarted);

    updatePriceHeader(liveByTf[currentLTF]);

    // El análisis y las señales usan solo velas CERRADAS (se descarta la última,
    // aún en formación) para que ninguna zona ni señal se "repinte" al cambiar el precio.
    const pipelines = {};
    ALL_TFS.forEach(tf => {
      const closed = liveByTf[tf].slice(0, -1);
      pipelines[tf] = { candles: closed, live: liveByTf[tf], ...runPipeline(closed, SWING_LOOKBACK[tf] || 2) };
    });
    const ltf = pipelines[currentLTF];
    const htf = pipelines[HTF_INTERVAL];
    const bias4h = pipelines['4h'];
    const keyLevels = ICT.computeKeyLevels(pipelines['1h'].candles);

    renderMtfBias(pipelines);
    const { vol, technical } = renderVolatilityIndicators(ltf.candles);
    renderStructurePanel(ltf.candles, ltf.swings, SWING_LOOKBACK[currentLTF] || 2);
    renderScenarios(ltf.candles, ltf.swings);
    updateCorrelation(htf.candles);

    let signalResult = ICT.generateSignal({
      ltfCandles: ltf.candles,
      ltfStructure: ltf.structure,
      htfStructure: htf.structure,
      biasStructure: bias4h.structure,
      obs: ltf.obs,
      fvgs: ltf.fvgs,
      srLevels: ltf.sr,
      liquidity: ltf.liquidity,
      pd: ltf.pd,
      sweeps: ltf.sweeps,
      technical, volatility: vol, keyLevels
    });
    const armed = checkArmedState(signalResult, currentLTF);
    renderArmedBanner(armed);
    maybeFireArmedAlert(armed);

    signalResult = applyCooldown(signalResult, currentLTF);
    renderChecklist(signalResult);
    const plan = ICT.computeTradePlan(signalResult, ltf.candles, ltf.sr, ltf.obs, ltf.fvgs);

    renderSignalPanel(signalResult, plan, ltf);
    maybeLogSignal(signalResult, plan);
    const evaluatedLog = evaluateSignalOutcomes(pipelines);
    renderLog(evaluatedLog);
    renderPerformance(evaluatedLog);
    renderPerformanceBreakdowns(evaluatedLog);
    window.__lastPipelines = { ltf, htf, bias4h };
    drawSecondaryPanel();

    const allTfSignals = computeAllTfSignals(pipelines, keyLevels);
    renderOpportunities(allTfSignals);

    const sessionLabel = { Asia: 'Asia', Londres: 'Londres', NY: 'Nueva York' }[sessionOf(ltf.candles[ltf.candles.length - 1].time)];
    document.getElementById('narrativeText').innerHTML = buildNarrative(signalResult, plan, ltf, htf, bias4h, vol, sessionLabel);
    renderDataQuality(fetchMs);

    if (!chart) {
      chart = new CandleChart(document.getElementById('chartCanvas'), document.getElementById('chartTooltip'), (offset) => {
        liveBtn.hidden = offset <= 0.5;
      });
      chart.setToggles(currentToggleStates());
    }
    chart.setData(ltf.live);
    const signalMarker = signalResult.signal !== 'NEUTRAL'
      ? [{ index: ltf.candles.length - 1, signal: signalResult.signal }]
      : [];
    chart.setOverlays({
      sr: ltf.sr, obs: ltf.obs, fvgs: ltf.fvgs, liquidity: ltf.liquidity,
      events: ltf.structure.events, pd: ltf.pd, signals: signalMarker, tradePlan: plan, keyLevels
    });
    chart.render();

    statusDot.className = 'dot live';
    lastUpdateEl.textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-ES');
    nextRefreshAt = Date.now() + REFRESH_MS;
  } catch (err) {
    console.error(err);
    statusDot.className = 'dot error';
    lastUpdateEl.textContent = 'Error al obtener datos: ' + err.message;
    nextRefreshAt = Date.now() + REFRESH_MS;
  }
}

function tickCountdown() {
  const secs = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
  nextRefreshEl.textContent = `Próxima actualización en ${secs}s`;
}

function wireTools() {
  const prefs = loadPrefs();
  const soundCb = document.getElementById('tg-sound');
  const notifyCb = document.getElementById('tg-notify');
  soundCb.checked = !!prefs.sound;
  notifyCb.checked = !!prefs.notify;
  if (prefs.balance != null) document.getElementById('calcBalance').value = prefs.balance;
  if (prefs.riskPct != null) document.getElementById('calcRisk').value = prefs.riskPct;

  soundCb.addEventListener('change', (e) => {
    savePrefs({ ...loadPrefs(), sound: e.target.checked });
    if (e.target.checked) playAlertSound('BUY');
  });
  notifyCb.addEventListener('change', async (e) => {
    if (e.target.checked && 'Notification' in window && Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { e.target.checked = false; }
    }
    savePrefs({ ...loadPrefs(), notify: e.target.checked });
  });

  document.getElementById('calcBalance').addEventListener('input', updatePositionCalc);
  document.getElementById('calcRisk').addEventListener('input', updatePositionCalc);

  wireCopyButton();
  wireShareButton();
}

const TOGGLE_MAP = {
  sr: 'tg-sr', obs: 'tg-obs', fvgs: 'tg-fvgs', liquidity: 'tg-liquidity', events: 'tg-events',
  pd: 'tg-pd', signals: 'tg-signals', tradePlan: 'tg-tradeplan', volume: 'tg-volume', sessions: 'tg-sessions',
  keyLevels: 'tg-keyLevels'
};

function restoreToggleCheckboxes() {
  const savedToggles = loadPrefs().toggles || {};
  Object.entries(TOGGLE_MAP).forEach(([key, id]) => {
    if (savedToggles[key] != null) document.getElementById(id).checked = savedToggles[key];
  });
}

function currentToggleStates() {
  const result = {};
  Object.keys(TOGGLE_MAP).forEach(key => { result[key] = document.getElementById(TOGGLE_MAP[key]).checked; });
  return result;
}

function wireToggles() {
  Object.entries(TOGGLE_MAP).forEach(([key, id]) => {
    document.getElementById(id).addEventListener('change', (e) => {
      chart.setToggles({ [key]: e.target.checked });
      chart.render();
      const toggles = loadPrefs().toggles || {};
      toggles[key] = e.target.checked;
      savePrefs({ ...loadPrefs(), toggles });
    });
  });
}

function wireLiveButton() {
  liveBtn.addEventListener('click', () => chart && chart.resetView());
}

function switchTimeframe(tf) {
  if (!ALL_TFS.includes(tf) || tf === currentLTF) return;
  document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === tf));
  currentLTF = tf;
  savePrefs({ ...loadPrefs(), tf: currentLTF });
  refresh().then(startAutoRefresh);
}

function wireTimeframes() {
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTimeframe(btn.dataset.tf));
  });
}

function restoreTimeframe() {
  const savedTf = loadPrefs().tf;
  if (savedTf && ALL_TFS.includes(savedTf)) {
    currentLTF = savedTf;
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === savedTf));
  }
}

let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => { await refresh(); startAutoRefresh(); }, REFRESH_MS);
}

window.addEventListener('resize', () => { if (chart) { chart.resize(); chart.render(); } });

restoreTimeframe();
restoreToggleCheckboxes();
wireToggles();
wireTimeframes();
wireTools();
wireLiveButton();
wireModeToggle();
wireBacktest();
wireSecondaryPanel();
wireExportCsv();
wireSync();
wireWebhooks();
wireOnboarding();
wirePerfScopeToggle();
renderLog(loadLog());
refresh().then(startAutoRefresh);
setInterval(tickCountdown, 1000);
