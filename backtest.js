/**
 * Backtest rápido "walk-forward" sobre las velas ya cargadas (ventana limitada
 * a lo que Binance devuelve, normalmente unos días/semanas según el timeframe).
 *
 * Para cada vela histórica i, la estructura/OB/FVG/SR/liquidez y la señal se
 * recalculan usando SOLO candles.slice(0, i+1) — es decir, nunca se usa
 * información del futuro para decidir si hay una entrada. Eso es lo que exige
 * evitar el "look-ahead bias".
 *
 * Limitación explícita y documentada: por costo computacional, el sesgo de
 * 1H y 4H que se usa en cada vela simulada es el de la ÚLTIMA estructura
 * calculada para esos timeframes (no se recalcula vela por vela en 1H/4H).
 * Esto es una aproximación razonable para una ventana corta, pero no es un
 * walk-forward perfecto multi-timeframe — se advierte en la UI.
 *
 * El resultado de cada operación simulada (TP1 o SL) SÍ mira hacia adelante,
 * pero eso es correcto: es la forma de MEDIR el resultado de una decisión ya
 * tomada con datos pasados, no de tomar la decisión.
 */
function runQuickBacktest(candles, swingLookback, htfStructureSnapshot, bias4hStructureSnapshot, minStart = 50) {
  const trades = [];
  let lastKey = null;

  for (let i = minStart; i < candles.length - 1; i++) {
    const slice = candles.slice(0, i + 1);
    const swings = ICT.detectSwings(slice, swingLookback);
    const structure = ICT.analyzeStructure(slice, swings);
    const obs = ICT.detectOrderBlocks(slice, structure.events);
    const fvgs = ICT.detectFVGs(slice);
    const sr = ICT.detectSRLevels(swings);
    const liquidity = ICT.detectLiquidity(swings);
    const pd = ICT.premiumDiscount(swings, slice[slice.length - 1].close);
    const sweeps = ICT.detectLiquiditySweep(slice, liquidity);

    const signalResult = ICT.generateSignal({
      ltfCandles: slice, ltfStructure: structure,
      htfStructure: htfStructureSnapshot, biasStructure: bias4hStructureSnapshot,
      obs, fvgs, srLevels: sr, liquidity, pd, sweeps
    });

    if (signalResult.signal === 'NEUTRAL') continue;
    const key = signalResult.time + '_' + signalResult.signal;
    if (key === lastKey) continue;
    lastKey = key;

    const plan = ICT.computeTradePlan(signalResult, slice, sr, obs, fvgs);
    if (!plan) continue;

    let outcome = 'pending';
    for (let j = i + 1; j < candles.length; j++) {
      const c = candles[j];
      if (signalResult.signal === 'BUY') {
        if (c.low <= plan.sl) { outcome = 'sl'; break; }
        if (c.high >= plan.tp1) { outcome = 'tp1'; break; }
      } else {
        if (c.high >= plan.sl) { outcome = 'sl'; break; }
        if (c.low <= plan.tp1) { outcome = 'tp1'; break; }
      }
    }

    trades.push({
      time: signalResult.time, signal: signalResult.signal, tier: signalResult.tier,
      entry: plan.entry, sl: plan.sl, tp1: plan.tp1, outcome
    });
  }

  return trades;
}

// Estadísticas compartidas entre el backtest y el historial real de señales.
function statsFromTrades(trades) {
  const resolved = trades.filter(t => t.outcome === 'tp1' || t.outcome === 'sl');
  const wins = resolved.filter(t => t.outcome === 'tp1');
  const rValues = resolved.map(t => {
    const risk = Math.abs(t.entry - t.sl);
    if (!risk) return 0;
    const reward = Math.abs(t.tp1 - t.entry);
    return t.outcome === 'tp1' ? reward / risk : -1;
  });
  const grossWin = rValues.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rValues.filter(r => r < 0).reduce((a, b) => a + b, 0));
  let curStreak = 0, curType = null, maxWinStreak = 0, maxLossStreak = 0;
  for (const t of resolved) {
    if (t.outcome === curType) curStreak++; else { curStreak = 1; curType = t.outcome; }
    if (t.outcome === 'tp1') maxWinStreak = Math.max(maxWinStreak, curStreak);
    else maxLossStreak = Math.max(maxLossStreak, curStreak);
  }
  return {
    totalSignals: trades.length,
    resolved: resolved.length,
    pending: trades.length - resolved.length,
    wins: wins.length,
    losses: resolved.length - wins.length,
    winRate: resolved.length ? (wins.length / resolved.length) * 100 : null,
    avgR: rValues.length ? rValues.reduce((a, b) => a + b, 0) / rValues.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    maxWinStreak, maxLossStreak
  };
}

window.BT = { runQuickBacktest, statsFromTrades };
