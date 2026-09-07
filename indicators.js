/**
 * Indicadores técnicos clásicos, usados SOLO como confirmación secundaria
 * (nunca como motivo principal de una entrada — eso lo exige el motor ICT
 * en analysis.js). Todo se calcula sobre las mismas velas reales ya
 * obtenidas de Binance; nada aquí inventa datos.
 */

function computeEMASeries(candles, period) {
  const ema = new Array(candles.length).fill(null);
  if (candles.length < period) return ema;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].close;
  ema[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) {
    ema[i] = candles[i].close * k + ema[i - 1] * (1 - k);
  }
  return ema;
}
function computeEMA(candles, period) {
  const s = computeEMASeries(candles, period);
  return s[s.length - 1];
}

function computeRSISeries(candles, period = 14) {
  const rsi = new Array(candles.length).fill(null);
  if (candles.length <= period) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0, loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}
function computeRSI(candles, period = 14) {
  const s = computeRSISeries(candles, period);
  return s[s.length - 1];
}

function computeMACD(candles) {
  const ema12 = computeEMASeries(candles, 12);
  const ema26 = computeEMASeries(candles, 26);
  const macdLine = candles.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null);
  const firstValid = macdLine.findIndex(v => v != null);
  if (firstValid === -1) return { macd: null, signal: null, histogram: null };
  const valid = macdLine.slice(firstValid);
  if (valid.length < 9) return { macd: valid[valid.length - 1], signal: null, histogram: null };
  const k = 2 / (9 + 1);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += valid[i];
  let signal = sum / 9;
  for (let i = 9; i < valid.length; i++) signal = valid[i] * k + signal * (1 - k);
  const macd = valid[valid.length - 1];
  return { macd, signal, histogram: macd - signal };
}

function computeBollinger(candles, period = 20, mult = 2) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period).map(c => c.close);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd, widthPct: (mult * sd * 2) / mean * 100 };
}

function computeATRSeries(candles, period = 14) {
  const n = candles.length;
  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  const atr = new Array(n).fill(null);
  if (n <= period) return atr;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

function computeADX(candles, period = 14) {
  const n = candles.length;
  if (n <= period * 2) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const upMove = c.high - p.high, downMove = p.low - c.low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  function wilderSmooth(arr) {
    const out = new Array(arr.length).fill(null);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += arr[i];
    out[period - 1] = sum;
    for (let i = period; i < arr.length; i++) out[i] = out[i - 1] - out[i - 1] / period + arr[i];
    return out;
  }
  const trS = wilderSmooth(tr), plusS = wilderSmooth(plusDM), minusS = wilderSmooth(minusDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    if (trS[i] == null || trS[i] === 0) continue;
    const plusDI = 100 * (plusS[i] / trS[i]);
    const minusDI = 100 * (minusS[i] / trS[i]);
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / sum);
  }
  if (dx.length < period) return null;
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
  return adx;
}

// ---------- Clasificación de volatilidad (ATR actual vs. su propio promedio reciente) ----------
function classifyVolatility(candles, period = 14) {
  const series = computeATRSeries(candles, period);
  const current = series[series.length - 1];
  const valid = series.filter(v => v != null);
  if (!current || valid.length < 20) return { level: 'DESCONOCIDA', atr: current || 0, avgAtr: 0, ratio: 1 };
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const ratio = current / avg;
  let level;
  if (ratio < 0.7) level = 'BAJA';
  else if (ratio < 1.3) level = 'NORMAL';
  else if (ratio < 1.9) level = 'ALTA';
  else level = 'EXTREMA';
  return { level, atr: current, avgAtr: avg, ratio };
}

// ---------- Bloque de confirmación técnica (peso reducido a propósito) ----------
// Devuelve un pequeño ajuste de puntaje (nunca decisivo por sí solo) más las
// lecturas para mostrar en el panel de indicadores.
function technicalConfirmation(candles) {
  const rsi = computeRSI(candles, 14);
  const ema9 = computeEMA(candles, 9);
  const ema20 = computeEMA(candles, 20);
  const ema50 = computeEMA(candles, 50);
  const ema200 = computeEMA(candles, 200);
  const macd = computeMACD(candles);
  const bb = computeBollinger(candles, 20, 2);
  const adx = computeADX(candles, 14);
  const price = candles[candles.length - 1].close;

  let bullBonus = 0, bearBonus = 0;
  const bullNotes = [], bearNotes = [];

  if (rsi != null) {
    if (rsi < 32) { bullBonus += 0.5; bullNotes.push(`RSI en sobreventa (${rsi.toFixed(0)})`); }
    if (rsi > 68) { bearBonus += 0.5; bearNotes.push(`RSI en sobrecompra (${rsi.toFixed(0)})`); }
  }
  if (ema9 != null && ema20 != null) {
    if (ema9 > ema20 && price > ema9) { bullBonus += 0.5; bullNotes.push('EMA9 > EMA20 y precio sobre ambas'); }
    if (ema9 < ema20 && price < ema9) { bearBonus += 0.5; bearNotes.push('EMA9 < EMA20 y precio bajo ambas'); }
  }
  if (macd.histogram != null) {
    if (macd.histogram > 0) { bullBonus += 0.3; bullNotes.push('MACD con histograma positivo'); }
    if (macd.histogram < 0) { bearBonus += 0.3; bearNotes.push('MACD con histograma negativo'); }
  }
  if (adx != null && adx >= 25) {
    if (ema9 != null && ema20 != null && ema9 > ema20) bullNotes.push(`ADX ${adx.toFixed(0)} confirma tendencia con fuerza`);
    else if (ema9 != null && ema20 != null) bearNotes.push(`ADX ${adx.toFixed(0)} confirma tendencia con fuerza`);
  }

  return {
    rsi, ema9, ema20, ema50, ema200, macd, bollinger: bb, adx,
    bullBonus, bearBonus, bullNotes, bearNotes
  };
}

window.IND = {
  computeEMA, computeEMASeries, computeRSI, computeRSISeries, computeMACD,
  computeBollinger, computeATRSeries, computeADX, classifyVolatility, technicalConfirmation
};
