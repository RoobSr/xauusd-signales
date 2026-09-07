/**
 * Motor de análisis tipo "Smart Money Concepts / ICT":
 * - Swings (fractales) -> estructura de mercado (BOS / CHoCH)
 * - Order Blocks
 * - Fair Value Gaps (FVG)
 * - Soportes / Resistencias (pisos / techos)
 * - Liquidez (equal highs / equal lows)
 * - Zonas Premium / Discount + OTE (Fibonacci 61.8%-79%)
 * - Generador de señales por confluencia
 *
 * Todas las funciones son puras: reciben velas (candles) y devuelven datos,
 * no tocan el DOM.
 */

// ---------- Swings (fractales) ----------
function detectSwings(candles, lookback = 3) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let k = 1; k <= lookback; k++) {
      if (candles[i - k].high >= c.high || candles[i + k].high >= c.high) isHigh = false;
      if (candles[i - k].low <= c.low || candles[i + k].low <= c.low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, time: c.time, price: c.high, type: 'high' });
    if (isLow) swings.push({ index: i, time: c.time, price: c.low, type: 'low' });
  }
  return swings;
}

// ---------- Estructura de mercado: BOS / CHoCH ----------
function analyzeStructure(candles, swings) {
  const events = [];
  let trend = 'unknown';
  let curHigh = null, curLow = null;
  let swingPtr = 0;
  const sorted = [...swings].sort((a, b) => a.index - b.index);

  for (let i = 0; i < candles.length; i++) {
    while (swingPtr < sorted.length && sorted[swingPtr].index === i) {
      const sw = sorted[swingPtr];
      if (sw.type === 'high') curHigh = sw;
      else curLow = sw;
      swingPtr++;
    }
    const close = candles[i].close;
    if (curHigh && i > curHigh.index && close > curHigh.price) {
      const isChoCH = trend === 'bearish';
      events.push({ index: i, time: candles[i].time, type: isChoCH ? 'CHoCH' : 'BOS', direction: 'bullish', price: curHigh.price });
      trend = 'bullish';
      curHigh = null;
    }
    if (curLow && i > curLow.index && close < curLow.price) {
      const isChoCH = trend === 'bullish';
      events.push({ index: i, time: candles[i].time, type: isChoCH ? 'CHoCH' : 'BOS', direction: 'bearish', price: curLow.price });
      trend = 'bearish';
      curLow = null;
    }
  }
  return { trend, events };
}

// ---------- Etiquetado HH / HL / LH / LL ----------
function labelSwings(swings) {
  const highs = swings.filter(s => s.type === 'high').sort((a, b) => a.index - b.index);
  const lows = swings.filter(s => s.type === 'low').sort((a, b) => a.index - b.index);
  const labeled = [];
  highs.forEach((h, i) => labeled.push({ ...h, label: i === 0 ? 'H' : (h.price > highs[i - 1].price ? 'HH' : 'LH') }));
  lows.forEach((l, i) => labeled.push({ ...l, label: i === 0 ? 'L' : (l.price > lows[i - 1].price ? 'HL' : 'LL') }));
  return labeled.sort((a, b) => a.index - b.index);
}

// ---------- Estructura interna (lookback corto) vs externa (lookback normal) ----------
function internalExternalStructure(candles, externalLookback) {
  const internalLookback = Math.max(1, Math.floor(externalLookback / 2));
  const extSwings = detectSwings(candles, externalLookback);
  const intSwings = detectSwings(candles, internalLookback);
  const external = analyzeStructure(candles, extSwings);
  const internal = analyzeStructure(candles, intSwings);
  return {
    external, internal,
    aligned: external.trend !== 'unknown' && external.trend === internal.trend
  };
}

// ---------- Motor de escenarios (niveles de invalidación explícitos) ----------
function buildScenarios(candles, swings) {
  const price = candles[candles.length - 1].close;
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const lastLow = lows.length ? lows[lows.length - 1] : null;
  const bullishTrigger = lastHigh ? lastHigh.price : price * 1.004;
  const bearishTrigger = lastLow ? lastLow.price : price * 0.996;
  return {
    bullishTrigger, bearishTrigger,
    bullishText: `Escenario alcista: cierre por encima de ${bullishTrigger.toFixed(2)} confirmaría ruptura de estructura al alza.`,
    bearishText: `Escenario bajista: cierre por debajo de ${bearishTrigger.toFixed(2)} confirmaría ruptura de estructura a la baja.`,
    neutralText: `Escenario neutral/rango mientras el precio se mantenga entre ${bearishTrigger.toFixed(2)} y ${bullishTrigger.toFixed(2)}.`
  };
}

// ---------- Niveles clave: máximo/mínimo del día anterior + rango asiático ----------
// Se calculan a partir de velas de 1H reales (agrupadas por día UTC), no inventados.
function computeKeyLevels(candles1h) {
  const days = {};
  for (const c of candles1h) {
    const day = new Date(c.time * 1000).toISOString().slice(0, 10);
    if (!days[day]) days[day] = { high: -Infinity, low: Infinity };
    days[day].high = Math.max(days[day].high, c.high);
    days[day].low = Math.min(days[day].low, c.low);
  }
  const dayKeys = Object.keys(days).sort();
  const todayKey = new Date().toISOString().slice(0, 10);
  const prevDayKey = [...dayKeys].reverse().find(d => d < todayKey);
  const pdh = prevDayKey ? days[prevDayKey].high : null;
  const pdl = prevDayKey ? days[prevDayKey].low : null;

  // Sesión asiática más reciente y completa (00:00-08:00 UTC)
  let asianHigh = null, asianLow = null;
  const recent = candles1h.slice(-72);
  let curBlock = [];
  const blocks = [];
  for (const c of recent) {
    const h = new Date(c.time * 1000).getUTCHours();
    if (h >= 0 && h < 8) curBlock.push(c);
    else { if (curBlock.length) blocks.push(curBlock); curBlock = []; }
  }
  if (curBlock.length) blocks.push(curBlock);
  const lastComplete = blocks.length >= 2 ? blocks[blocks.length - 2] : blocks[blocks.length - 1];
  if (lastComplete && lastComplete.length) {
    asianHigh = Math.max(...lastComplete.map(c => c.high));
    asianLow = Math.min(...lastComplete.map(c => c.low));
  }
  return { pdh, pdl, asianHigh, asianLow };
}

// ---------- Categoría de confianza ----------
function confidenceCategory(confidence) {
  if (confidence >= 85) return 'MUY ALTA';
  if (confidence >= 65) return 'ALTA';
  if (confidence >= 40) return 'MEDIA';
  return 'BAJA';
}

// ---------- Order Blocks ----------
function detectOrderBlocks(candles, structureEvents) {
  const obs = [];
  for (const ev of structureEvents) {
    const breakIndex = ev.index;
    const searchFrom = Math.max(0, breakIndex - 12);
    if (ev.direction === 'bullish') {
      for (let i = breakIndex; i >= searchFrom; i--) {
        if (candles[i].close < candles[i].open) {
          obs.push({ type: 'bullish', top: candles[i].high, bottom: candles[i].low, index: i, time: candles[i].time, breakIndex, mitigated: false, originEvent: ev.type });
          break;
        }
      }
    } else {
      for (let i = breakIndex; i >= searchFrom; i--) {
        if (candles[i].close > candles[i].open) {
          obs.push({ type: 'bearish', top: candles[i].high, bottom: candles[i].low, index: i, time: candles[i].time, breakIndex, mitigated: false, originEvent: ev.type });
          break;
        }
      }
    }
  }
  for (const ob of obs) {
    for (let i = ob.breakIndex + 1; i < candles.length; i++) {
      const c = candles[i];
      if (c.low <= ob.top && c.high >= ob.bottom) { ob.mitigated = true; ob.mitigatedAt = i; break; }
    }
  }
  // dedupe (mismo index puede repetirse por varios eventos)
  const seen = new Set();
  return obs.filter(o => {
    const key = o.type + '_' + o.index;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- Fair Value Gaps ----------
function detectFVGs(candles) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const a = candles[i - 1], c = candles[i + 1];
    if (a.high < c.low) {
      fvgs.push({ type: 'bullish', top: c.low, bottom: a.high, index: i, time: candles[i].time, mitigated: false });
    } else if (a.low > c.high) {
      fvgs.push({ type: 'bearish', top: a.low, bottom: c.high, index: i, time: candles[i].time, mitigated: false });
    }
  }
  for (const g of fvgs) {
    for (let i = g.index + 2; i < candles.length; i++) {
      const c = candles[i];
      if (c.low <= g.top && c.high >= g.bottom) { g.mitigated = true; g.mitigatedAt = i; break; }
    }
  }
  return fvgs;
}

// ---------- Soportes / Resistencias (pisos / techos) ----------
function detectSRLevels(swings, tolerancePct = 0.0018) {
  const clusters = [];
  for (const p of swings) {
    let cluster = clusters.find(c => Math.abs((c.sum / c.count) - p.price) / p.price < tolerancePct);
    if (!cluster) {
      cluster = { sum: 0, count: 0, lastTime: 0, lowTouches: 0, highTouches: 0 };
      clusters.push(cluster);
    }
    cluster.sum += p.price;
    cluster.count += 1;
    cluster.lastTime = Math.max(cluster.lastTime, p.time);
    if (p.type === 'low') cluster.lowTouches++; else cluster.highTouches++;
  }
  return clusters
    .map(c => ({ price: c.sum / c.count, touches: c.count, lastTime: c.lastTime, lowTouches: c.lowTouches, highTouches: c.highTouches }))
    .filter(c => c.touches >= 2)
    .sort((a, b) => b.touches - a.touches)
    .slice(0, 10);
}

// ---------- Liquidez: equal highs (BSL) / equal lows (SSL) ----------
function detectLiquidity(swings, tolerancePct = 0.0009, lookbackCount = 60) {
  const recent = swings.slice(-lookbackCount);
  const highs = recent.filter(s => s.type === 'high');
  const lows = recent.filter(s => s.type === 'low');
  const pools = [];
  const clusterFn = (arr, kind) => {
    const used = new Array(arr.length).fill(false);
    for (let i = 0; i < arr.length; i++) {
      if (used[i]) continue;
      const group = [arr[i]];
      for (let j = i + 1; j < arr.length; j++) {
        if (used[j]) continue;
        if (Math.abs(arr[i].price - arr[j].price) / arr[i].price < tolerancePct) {
          group.push(arr[j]);
          used[j] = true;
        }
      }
      if (group.length >= 2) {
        const avg = group.reduce((s, g) => s + g.price, 0) / group.length;
        pools.push({ type: kind, price: avg, count: group.length, time: group[group.length - 1].time });
      }
    }
  };
  clusterFn(highs, 'BSL');
  clusterFn(lows, 'SSL');
  return pools;
}

// ---------- Premium / Discount + OTE ----------
function premiumDiscount(swings, currentPrice) {
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  if (!highs.length || !lows.length) return null;
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  const top = Math.max(lastHigh.price, lastLow.price);
  const bottom = Math.min(lastHigh.price, lastLow.price);
  const range = top - bottom;
  if (range <= 0) return null;
  const eq = (top + bottom) / 2;
  const oteBuy = [bottom + range * 0.618, bottom + range * 0.79];
  const oteSell = [top - range * 0.79, top - range * 0.618];
  return {
    top, bottom, eq, oteBuy, oteSell,
    zone: currentPrice < eq ? 'discount' : 'premium'
  };
}

// ---------- ATR simple ----------
function computeATR(candles, period = 14) {
  const n = candles.length;
  if (n < period + 1) return 0;
  let sum = 0;
  for (let i = n - period; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    sum += tr;
  }
  return sum / period;
}

// ---------- Liquidity sweep (barrido) + reversión reciente ----------
function detectLiquiditySweep(candles, liquidityPools, lookback = 6) {
  const n = candles.length;
  const results = [];
  for (const pool of liquidityPools) {
    for (let i = Math.max(0, n - lookback); i < n; i++) {
      const c = candles[i];
      if (pool.type === 'SSL' && c.low < pool.price && c.close > pool.price) {
        results.push({ ...pool, sweptAt: i, direction: 'bullish' });
      }
      if (pool.type === 'BSL' && c.high > pool.price && c.close < pool.price) {
        results.push({ ...pool, sweptAt: i, direction: 'bearish' });
      }
    }
  }
  return results;
}

// ---------- Generador de señal por confluencia ----------
// Reglas de calidad de entrada:
//  1) Solo se evalúa la última vela CERRADA (ltfCandles no debe incluir la vela en formación) -> sin repintado.
//  2) Ninguna señal se emite "desnuda": debe estar anclada a un Order Block, FVG o barrido de
//     liquidez sin mitigar, Y la vela de cierre debe confirmar la dirección (vela alcista en zona
//     alcista, bajista en zona bajista) -> exige una reacción real del precio, no solo "estar cerca".
//  3) Veto de tendencia mayor: una señal contraria a la estructura de 4H solo se acepta si la
//     confluencia es muy superior al umbral (evita operar contra la tendencia dominante sin motivo fuerte).
//  4) Cada señal se clasifica en calidad A+ (>=4 categorías de confluencia independientes),
//     B (>=2) o C (mínimo indispensable) para que el usuario dimensione el riesgo.
function generateSignal({ ltfCandles, ltfStructure, htfStructure, biasStructure, obs, fvgs, srLevels, liquidity, pd, sweeps, technical, volatility, keyLevels }) {
  const last = ltfCandles[ltfCandles.length - 1];
  const price = last.close;
  const isBullCandle = last.close > last.open;
  const isBearCandle = last.close < last.open;

  let bullScore = 0, bearScore = 0, bullCategories = 0, bearCategories = 0;
  let bullAnchor = false, bearAnchor = false;
  let bullAnchorType = null, bearAnchorType = null, bullKeyLevelType = null, bearKeyLevelType = null;
  const bullReasons = [], bearReasons = [];
  const checklist = [];
  const breakdown = {
    trend: { bull: 0, bear: 0 }, structure: { bull: 0, bear: 0 }, zone: { bull: 0, bear: 0 },
    srLevel: { bull: 0, bear: 0 }, premiumDiscount: { bull: 0, bear: 0 },
    liquidity: { bull: 0, bear: 0 }, technical: { bull: 0, bear: 0 }, keyLevel: { bull: 0, bear: 0 }
  };

  checklist.push({ label: 'Tendencia 1H definida', passed: htfStructure.trend !== 'unknown' });
  if (htfStructure.trend === 'bullish') { bullScore += 1.5; bullCategories++; bullReasons.push('Tendencia 1H alcista'); breakdown.trend.bull = 1.5; }
  if (htfStructure.trend === 'bearish') { bearScore += 1.5; bearCategories++; bearReasons.push('Tendencia 1H bajista'); breakdown.trend.bear = 1.5; }

  const lastEvent = ltfStructure.events[ltfStructure.events.length - 1];
  const recentEvent = lastEvent && last.time - lastEvent.time < 3600 * 6;
  checklist.push({ label: 'Evento de estructura reciente (BOS/CHoCH)', passed: !!recentEvent });
  if (recentEvent) {
    const tag = lastEvent.type === 'CHoCH' ? 'Cambio de carácter (CHoCH)' : 'Ruptura de estructura (BOS)';
    const w = lastEvent.type === 'CHoCH' ? 2 : 1.2;
    if (lastEvent.direction === 'bullish') { bullScore += w; bullCategories++; bullReasons.push(`${tag} alcista confirmado`); breakdown.structure.bull = w; }
    else { bearScore += w; bearCategories++; bearReasons.push(`${tag} bajista confirmado`); breakdown.structure.bear = w; }
  }

  // Zonas de entrada (PD arrays) — requieren vela de confirmación en la misma dirección
  const activeBullOB = obs.filter(o => o.type === 'bullish' && !o.mitigated).find(o => price <= o.top && price >= o.bottom);
  const activeBearOB = obs.filter(o => o.type === 'bearish' && !o.mitigated).find(o => price <= o.top && price >= o.bottom);
  const activeBullFVG = fvgs.filter(g => g.type === 'bullish' && !g.mitigated).find(g => price <= g.top && price >= g.bottom);
  const activeBearFVG = fvgs.filter(g => g.type === 'bearish' && !g.mitigated).find(g => price <= g.top && price >= g.bottom);

  if (activeBullOB && isBullCandle) { bullScore += 2; bullCategories++; bullAnchor = true; bullAnchorType = 'OB'; bullReasons.push('Vela de confirmación alcista dentro de Order Block sin mitigar'); breakdown.zone.bull += 2; }
  else if (activeBullOB) { bullReasons.push('Precio en Order Block alcista, esperando vela de confirmación'); }
  if (activeBearOB && isBearCandle) { bearScore += 2; bearCategories++; bearAnchor = true; bearAnchorType = 'OB'; bearReasons.push('Vela de confirmación bajista dentro de Order Block sin mitigar'); breakdown.zone.bear += 2; }
  else if (activeBearOB) { bearReasons.push('Precio en Order Block bajista, esperando vela de confirmación'); }

  if (activeBullFVG && isBullCandle) { bullScore += 1.5; bullCategories++; bullAnchor = true; if (!bullAnchorType) bullAnchorType = 'FVG'; bullReasons.push('Vela de confirmación alcista dentro de Fair Value Gap'); breakdown.zone.bull += 1.5; }
  else if (activeBullFVG) { bullReasons.push('Precio en FVG alcista, esperando vela de confirmación'); }
  if (activeBearFVG && isBearCandle) { bearScore += 1.5; bearCategories++; bearAnchor = true; if (!bearAnchorType) bearAnchorType = 'FVG'; bearReasons.push('Vela de confirmación bajista dentro de Fair Value Gap'); breakdown.zone.bear += 1.5; }
  else if (activeBearFVG) { bearReasons.push('Precio en FVG bajista, esperando vela de confirmación'); }

  const nearSupport = srLevels.find(l => l.lowTouches > 0 && Math.abs(price - l.price) / price < 0.0025 && price >= l.price - price * 0.0025);
  if (nearSupport) { bullScore += 1; bullCategories++; bullReasons.push('Cerca de soporte clave (piso)'); breakdown.srLevel.bull = 1; }
  const nearResistance = srLevels.find(l => l.highTouches > 0 && Math.abs(price - l.price) / price < 0.0025 && price <= l.price + price * 0.0025);
  if (nearResistance) { bearScore += 1; bearCategories++; bearReasons.push('Cerca de resistencia clave (techo)'); breakdown.srLevel.bear = 1; }

  // Niveles clave (PDH/PDL, rango asiático) — reacción de precio real cerca de referencias institucionales
  if (keyLevels) {
    const nearTol = price * 0.0022;
    const checks = [
      ['pdl', keyLevels.pdl, 'mínimo del día anterior (PDL)', 'bull'],
      ['pdh', keyLevels.pdh, 'máximo del día anterior (PDH)', 'bear'],
      ['asianLow', keyLevels.asianLow, 'mínimo de la sesión asiática', 'bull'],
      ['asianHigh', keyLevels.asianHigh, 'máximo de la sesión asiática', 'bear']
    ];
    for (const [key, lvl, label, dir] of checks) {
      if (lvl == null || Math.abs(price - lvl) > nearTol) continue;
      if (dir === 'bull' && isBullCandle) { bullScore += 1; bullCategories++; bullKeyLevelType = key; bullReasons.push(`Reacción alcista cerca del ${label}`); breakdown.keyLevel.bull += 1; }
      if (dir === 'bear' && isBearCandle) { bearScore += 1; bearCategories++; bearKeyLevelType = key; bearReasons.push(`Reacción bajista cerca del ${label}`); breakdown.keyLevel.bear += 1; }
    }
  }

  if (pd) {
    if (pd.zone === 'discount') { bullScore += 1; bullCategories++; bullReasons.push('Precio en zona de descuento (discount)'); breakdown.premiumDiscount.bull += 1; }
    else { bearScore += 1; bearCategories++; bearReasons.push('Precio en zona de premium'); breakdown.premiumDiscount.bear += 1; }
    if (price >= pd.oteBuy[0] && price <= pd.oteBuy[1]) { bullScore += 1.2; bullCategories++; bullReasons.push('Precio en zona OTE de compra (61.8%-79%)'); breakdown.premiumDiscount.bull += 1.2; }
    if (price >= pd.oteSell[0] && price <= pd.oteSell[1]) { bearScore += 1.2; bearCategories++; bearReasons.push('Precio en zona OTE de venta (61.8%-79%)'); breakdown.premiumDiscount.bear += 1.2; }
  }

  let sweepBull = false, sweepBear = false;
  for (const s of sweeps) {
    if (s.sweptAt >= ltfCandles.length - 3) {
      if (s.direction === 'bullish') sweepBull = true;
      else sweepBear = true;
    }
  }
  if (sweepBull) { bullScore += 2; bullCategories++; bullAnchor = true; bullAnchorType = 'SWEEP'; bullReasons.push('Barrido de liquidez (SSL) + reversión alcista'); breakdown.liquidity.bull = 2; }
  if (sweepBear) { bearScore += 2; bearCategories++; bearAnchor = true; bearAnchorType = 'SWEEP'; bearReasons.push('Barrido de liquidez (BSL) + reversión bajista'); breakdown.liquidity.bear = 2; }
  checklist.push({ label: 'Zona de entrada anclada (Order Block, FVG o barrido de liquidez)', passed: bullAnchor || bearAnchor });

  // Confirmación técnica secundaria — peso deliberadamente pequeño, nunca decide por sí sola
  if (technical) {
    bullScore += technical.bullBonus || 0;
    bearScore += technical.bearBonus || 0;
    breakdown.technical.bull = technical.bullBonus || 0;
    breakdown.technical.bear = technical.bearBonus || 0;
    if (technical.bullBonus) bullReasons.push(...technical.bullNotes);
    if (technical.bearBonus) bearReasons.push(...technical.bearNotes);
  }

  const netScore = bullScore - bearScore;
  const extremeVol = volatility && volatility.level === 'EXTREMA';
  const threshold = extremeVol ? 4.5 : 3;
  checklist.push({ label: 'Volatilidad no extrema (o confluencia reforzada si lo es)', passed: !extremeVol });
  const maxPossible = 12;
  const tierOf = (categories) => (categories >= 4 ? 'A+' : categories >= 2 ? 'B' : 'C');
  const isCounterTrend4h = (dir) => biasStructure && biasStructure.trend !== 'unknown' &&
    ((dir === 'bullish' && biasStructure.trend === 'bearish') || (dir === 'bearish' && biasStructure.trend === 'bullish'));
  checklist.push({ label: 'Sin veto de tendencia 4H', passed: !isCounterTrend4h(netScore >= 0 ? 'bullish' : 'bearish') || Math.abs(netScore) >= threshold + 2 });
  checklist.push({ label: `Puntaje mínimo alcanzado (≥ ${threshold})`, passed: Math.abs(netScore) >= threshold });

  let signal = 'NEUTRAL', confidence = 0, reasons = [], tier = null;

  if (netScore >= threshold && bullAnchor) {
    if (isCounterTrend4h('bullish') && netScore < threshold + 2) {
      signal = 'NEUTRAL';
      confidence = Math.round((bullScore / maxPossible) * 50);
      reasons = [...bullReasons, '⚠ Descartada: contraria a la tendencia de 4H sin confluencia suficiente para justificarla'];
    } else {
      signal = 'BUY';
      confidence = Math.min(100, Math.round((bullScore / maxPossible) * 100));
      reasons = bullReasons;
      tier = tierOf(bullCategories);
    }
  } else if (netScore <= -threshold && bearAnchor) {
    if (isCounterTrend4h('bearish') && netScore > -(threshold + 2)) {
      signal = 'NEUTRAL';
      confidence = Math.round((bearScore / maxPossible) * 50);
      reasons = [...bearReasons, '⚠ Descartada: contraria a la tendencia de 4H sin confluencia suficiente para justificarla'];
    } else {
      signal = 'SELL';
      confidence = Math.min(100, Math.round((bearScore / maxPossible) * 100));
      reasons = bearReasons;
      tier = tierOf(bearCategories);
    }
  } else {
    const dominant = bullScore >= bearScore ? 'bullish' : 'bearish';
    confidence = Math.round((Math.max(bullScore, bearScore) / maxPossible) * 55);
    reasons = dominant === 'bullish' ? bullReasons : bearReasons;
    if (netScore >= threshold && !bullAnchor) reasons = [...reasons, 'Puntaje suficiente pero sin Order Block/FVG/liquidez confirmando la entrada — esperando'];
    if (netScore <= -threshold && !bearAnchor) reasons = [...reasons, 'Puntaje suficiente pero sin Order Block/FVG/liquidez confirmando la entrada — esperando'];
    if (extremeVol) reasons = [...reasons, 'Volatilidad EXTREMA: se exige el doble de confluencia de lo normal'];
  }

  const anchorType = signal === 'BUY' ? bullAnchorType : signal === 'SELL' ? bearAnchorType : null;
  const keyLevelType = signal === 'BUY' ? bullKeyLevelType : signal === 'SELL' ? bearKeyLevelType : null;
  const lastEventType = recentEvent ? lastEvent.type : null;
  const setup = classifySetup({ signal, anchorType, lastEventType, keyLevelType });

  return {
    signal, confidence, confidenceLabel: confidenceCategory(confidence), tier,
    bullScore, bearScore, reasons, checklist, breakdown, price, time: last.time,
    anchorType, keyLevelType, lastEventType, setup
  };
}

// ---------- Clasificador de "setups" nombrados ----------
// Traduce las mismas confluencias ya detectadas a los patrones clásicos de
// Smart Money Concepts, para que la señal diga no solo "por qué" sino "qué
// tipo de setup es" en términos que un trader ICT reconoce.
function classifySetup({ signal, anchorType, lastEventType, keyLevelType }) {
  if (signal === 'NEUTRAL') return null;
  if (anchorType === 'SWEEP' && lastEventType === 'CHoCH') {
    return { code: 'A', name: 'Liquidity Sweep + CHoCH', desc: 'Barrido de liquidez seguido de un cambio de carácter — reversión clásica de smart money.' };
  }
  if (keyLevelType === 'asianHigh' || keyLevelType === 'asianLow') {
    return { code: 'G', name: 'Barrido de Rango Asiático', desc: 'Barrido del rango asiático con reacción durante la sesión de Londres/NY — continuación clásica tras liquidez asiática.' };
  }
  if (keyLevelType === 'pdh' || keyLevelType === 'pdl') {
    return { code: 'F', name: 'Barrido de PDH/PDL + Reversión', desc: 'Barrido del máximo o mínimo del día anterior con reacción de precio — liquidez institucional clásica.' };
  }
  if (anchorType === 'SWEEP') {
    return { code: 'C', name: 'Barrido de Liquidez + Reversión', desc: 'Barrido de un pool de liquidez con reversión inmediata, sin ruptura de estructura previa confirmada.' };
  }
  if (anchorType === 'OB' && lastEventType === 'BOS') {
    return { code: 'B', name: 'BOS + Continuación en Order Block', desc: 'Ruptura de estructura seguida de un retroceso al Order Block de origen — continuación de tendencia.' };
  }
  if (anchorType === 'FVG' && lastEventType) {
    return { code: 'H', name: 'FVG tras Displacement', desc: 'Vela de expansión (displacement) dejó un Fair Value Gap y el precio regresó a rellenarlo parcialmente.' };
  }
  return { code: '—', name: 'Confluencia General', desc: 'Cumple el puntaje mínimo por combinación de factores, sin encajar en un patrón específico predefinido.' };
}

// ---------- Plan de trade (zona de entrada / nivel inválido / TP1-TP3) ----------
// Los TP se buscan en niveles reales de S/R, pero nunca por debajo de un R:R mínimo
// (1R, 2R, 3R) para no proponer un TP casi pegado a la entrada si por casualidad hay
// un nivel muy cercano. La zona de entrada prioriza el mismo Order Block que ancló
// la señal (el que realmente contiene el precio); si no hay OB usa el FVG que la
// ancló; y solo si ninguno de los dos existe cae a un colchón genérico de ATR
// (zona más débil, se marca explícitamente como tal para que el usuario lo sepa).
function computeTradePlan(signalResult, ltfCandles, srLevels, obs, fvgs) {
  if (!signalResult || signalResult.signal === 'NEUTRAL') return null;
  const atr = computeATR(ltfCandles, 14) || (signalResult.price * 0.001);
  const price = signalResult.price;
  fvgs = fvgs || [];

  function pickZone(type) {
    const relevantOB = obs
      .filter(o => o.type === type && !o.mitigated && price <= o.top && price >= o.bottom)
      .sort((a, b) => b.index - a.index)[0];
    if (relevantOB) return { bottom: relevantOB.bottom, top: relevantOB.top, source: 'OB' };
    const relevantFVG = fvgs
      .filter(g => g.type === type && !g.mitigated && price <= g.top && price >= g.bottom)
      .sort((a, b) => b.index - a.index)[0];
    if (relevantFVG) return { bottom: relevantFVG.bottom, top: relevantFVG.top, source: 'FVG' };
    return { bottom: price - atr * 0.15, top: price + atr * 0.15, source: 'ATR' };
  }

  if (signalResult.signal === 'BUY') {
    const zone = pickZone('bullish');
    const entryZone = [zone.bottom, Math.max(zone.top, price)];
    const sl = entryZone[0] - atr * 0.3;
    const risk = Math.max(price - sl, atr * 0.5);

    const resistances = srLevels.filter(l => l.price > price).sort((a, b) => a.price - b.price);
    const tp1 = resistances.find(l => l.price >= price + risk)?.price ?? (price + risk * 1.5);
    const tp2 = resistances.find(l => l.price >= Math.max(tp1 + risk * 0.5, price + risk * 2))?.price ?? Math.max(tp1 + risk, price + risk * 2.5);
    const tp3 = resistances.find(l => l.price >= Math.max(tp2 + risk * 0.5, price + risk * 3))?.price ?? Math.max(tp2 + risk, price + risk * 4);
    return {
      direction: 'BUY', entryZone, entryZoneSource: zone.source, entryZoneWidth: entryZone[1] - entryZone[0],
      entry: price, sl, tp1, tp2, tp3,
      rr1: ((tp1 - price) / risk).toFixed(2),
      rr2: ((tp2 - price) / risk).toFixed(2),
      rr3: ((tp3 - price) / risk).toFixed(2)
    };
  } else {
    const zone = pickZone('bearish');
    const entryZone = [Math.min(zone.bottom, price), zone.top];
    const sl = entryZone[1] + atr * 0.3;
    const risk = Math.max(sl - price, atr * 0.5);

    const supports = srLevels.filter(l => l.price < price).sort((a, b) => b.price - a.price);
    const tp1 = supports.find(l => l.price <= price - risk)?.price ?? (price - risk * 1.5);
    const tp2 = supports.find(l => l.price <= Math.min(tp1 - risk * 0.5, price - risk * 2))?.price ?? Math.min(tp1 - risk, price - risk * 2.5);
    const tp3 = supports.find(l => l.price <= Math.min(tp2 - risk * 0.5, price - risk * 3))?.price ?? Math.min(tp2 - risk, price - risk * 4);
    return {
      direction: 'SELL', entryZone, entryZoneSource: zone.source, entryZoneWidth: entryZone[1] - entryZone[0],
      entry: price, sl, tp1, tp2, tp3,
      rr1: ((price - tp1) / risk).toFixed(2),
      rr2: ((price - tp2) / risk).toFixed(2),
      rr3: ((price - tp3) / risk).toFixed(2)
    };
  }
}

// Exponer todo en un namespace global simple (sin bundlers)
window.ICT = {
  detectSwings, analyzeStructure, detectOrderBlocks, detectFVGs,
  detectSRLevels, detectLiquidity, premiumDiscount, computeATR,
  detectLiquiditySweep, generateSignal, computeTradePlan,
  labelSwings, internalExternalStructure, buildScenarios, confidenceCategory, computeKeyLevels, classifySetup
};
