/**
 * Renderizador de velas en <canvas>, sin dependencias externas.
 * Dibuja: velas, soportes/resistencias, order blocks, FVG, liquidez,
 * eventos BOS/CHoCH y marcadores de señales BUY/SELL.
 * Soporta zoom (rueda) y pan (arrastrar).
 */
const VOLUME_RATIO = 0.16;

class CandleChart {
  constructor(canvas, tooltipEl, onViewChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tooltipEl = tooltipEl;
    this.onViewChange = onViewChange || (() => {});
    this.candles = [];
    this.overlays = { sr: [], obs: [], fvgs: [], liquidity: [], events: [], signals: [], pd: null, tradePlan: null, keyLevels: null };
    this.toggles = { sr: true, obs: true, fvgs: true, liquidity: true, events: true, signals: true, tradePlan: true, volume: true, sessions: true, keyLevels: true };
    this.visibleCount = 130;
    this.offset = 0; // desde el final, en velas
    this.margin = { top: 24, right: 72, bottom: 26, left: 8 };
    this.dpr = window.devicePixelRatio || 1;

    this._bindEvents();
    this.resize();

    // Loop de animación liviano: solo vuelve a dibujar (para el pulso de la
    // Entry Zone o de las zonas de posible entrada) mientras ese overlay esté activo.
    setInterval(() => {
      if (this.toggles.tradePlan) this.render();
    }, 200);
  }

  resetView() {
    this.offset = 0;
    this.render();
    this.onViewChange(this.offset);
  }

  setData(candles) {
    this.candles = candles;
    if (this.visibleCount > candles.length) this.visibleCount = candles.length;
  }

  setOverlays(overlays) { this.overlays = { ...this.overlays, ...overlays }; }
  setToggles(t) { this.toggles = { ...this.toggles, ...t }; }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
  }

  _bindEvents() {
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1 : -1;
      this.visibleCount = Math.min(this.candles.length, Math.max(25, this.visibleCount + delta * 8));
      this.render();
      this.onViewChange(this.offset);
    }, { passive: false });

    let dragging = false, lastX = 0;
    this.canvas.addEventListener('mousedown', (e) => { e.preventDefault(); dragging = true; lastX = e.clientX; });
    window.addEventListener('mouseup', () => { dragging = false; });
    this.canvas.addEventListener('mouseleave', () => { if (this.tooltipEl) this.tooltipEl.style.display = 'none'; });
    this.canvas.addEventListener('mousemove', (e) => {
      if (dragging) {
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        const step = this._candleStep();
        this.offset -= dx / step;
        this._clampOffset();
        this.render();
        this.onViewChange(this.offset);
      }
      this._updateTooltip(e);
    });
  }

  _plotHeight() {
    return this.h - this.margin.top - this.margin.bottom;
  }

  _priceHeight() {
    return this.toggles.volume ? this._plotHeight() * (1 - VOLUME_RATIO) : this._plotHeight();
  }

  _clampOffset() {
    const maxOffset = Math.max(0, this.candles.length - this.visibleCount);
    if (this.offset < 0) this.offset = 0;
    if (this.offset > maxOffset) this.offset = maxOffset;
  }

  _visibleRange() {
    const n = this.candles.length;
    const end = n - Math.round(this.offset);
    const start = Math.max(0, end - this.visibleCount);
    return { start, end: Math.max(start + 1, end) };
  }

  _candleStep() {
    const plotWidth = this.w - this.margin.left - this.margin.right;
    return plotWidth / this.visibleCount;
  }

  _priceBounds(start, end) {
    let min = Infinity, max = -Infinity;
    for (let i = start; i < end; i++) {
      const c = this.candles[i];
      if (!c) continue;
      if (c.low < min) min = c.low;
      if (c.high > max) max = c.high;
    }
    if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1 };
    const pad = (max - min) * 0.08 || max * 0.001;
    return { min: min - pad, max: max + pad };
  }

  xForIndex(i, start) {
    const step = this._candleStep();
    return this.margin.left + (i - start) * step + step / 2;
  }

  yForPrice(p, bounds) {
    return this.margin.top + (bounds.max - p) / (bounds.max - bounds.min) * this._priceHeight();
  }

  _updateTooltip(e) {
    if (!this.tooltipEl || !this.candles.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { start, end } = this._visibleRange();
    const step = this._candleStep();
    let idx = start + Math.floor((x - this.margin.left) / step);
    idx = Math.max(start, Math.min(end - 1, idx));
    const c = this.candles[idx];
    if (!c || x < this.margin.left || x > this.w - this.margin.right || y < this.margin.top || y > this.h - this.margin.bottom) {
      this.tooltipEl.style.display = 'none';
      return;
    }
    const d = new Date(c.time * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    this.tooltipEl.innerHTML = `
      <div class="tt-time">${dd}/${mo} ${hh}:${mm}</div>
      <div>O <b>${c.open.toFixed(2)}</b> &nbsp;H <b>${c.high.toFixed(2)}</b></div>
      <div>L <b>${c.low.toFixed(2)}</b> &nbsp;C <b>${c.close.toFixed(2)}</b></div>
    `;
    this.tooltipEl.style.display = 'block';
    this.tooltipEl.style.left = Math.min(this.w - 140, x + 14) + 'px';
    this.tooltipEl.style.top = Math.max(0, y - 50) + 'px';
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.candles.length) return;

    this._clampOffset();
    const { start, end } = this._visibleRange();
    let bounds = this._priceBounds(start, end);
    const planEnabled = this.toggles.tradePlan;
    const plan = planEnabled ? this.overlays.tradePlan : null;
    const potentials = (planEnabled && !plan) ? this._findPotentialEntries() : [];
    if (plan) bounds = this._expandBoundsForValues(bounds, [plan.sl, plan.tp1, plan.tp2, plan.tp3, plan.entryZone[0], plan.entryZone[1]]);
    if (potentials.length) bounds = this._expandBoundsForValues(bounds, potentials.flatMap(p => [p.top, p.bottom]));
    const step = this._candleStep();

    if (this.toggles.sessions) this._drawSessions(start, end);
    this._drawGrid(bounds);
    if (this.toggles.pd && this.overlays.pd) this._drawPremiumDiscount(this.overlays.pd, start, end, bounds);
    if (this.toggles.obs) this._drawZones(this.overlays.obs, start, end, bounds, 'ob');
    if (this.toggles.fvgs) this._drawZones(this.overlays.fvgs, start, end, bounds, 'fvg');
    if (this.toggles.sr) this._drawHLines(this.overlays.sr, bounds, 'sr');
    if (this.toggles.liquidity) this._drawHLines(this.overlays.liquidity, bounds, 'liq');
    if (this.toggles.keyLevels && this.overlays.keyLevels) this._drawKeyLevels(this.overlays.keyLevels, bounds);
    this._drawCandles(start, end, bounds, step);
    if (this.toggles.volume) this._drawVolume(start, end, step);
    if (this.toggles.events) this._drawEvents(this.overlays.events, start, end, bounds);
    if (this.toggles.signals) this._drawSignals(this.overlays.signals, start, end, bounds);
    if (plan) this._drawTradePlan(plan, bounds);
    else if (potentials.length) this._drawPotentialEntries(potentials, bounds);
    this._drawPriceAxis(bounds);
    this._drawCurrentPriceLine(bounds);
    this._drawTimeAxis(start, end);
  }

  _expandBoundsForValues(bounds, values) {
    const finite = values.filter(v => isFinite(v));
    if (!finite.length) return bounds;
    let min = Math.min(bounds.min, ...finite);
    let max = Math.max(bounds.max, ...finite);
    const pad = (max - min) * 0.04;
    return { min: min - pad, max: max + pad };
  }

  // Cuando no hay señal/plan activo, busca la zona no mitigada más cercana al
  // precio en vivo a cada lado (un Order Block/FVG alcista por debajo = posible
  // compra, uno bajista por encima = posible venta) para dar una pista visual
  // de "por qué aquí" sin fingir que ya hay una señal confirmada.
  _findPotentialEntries() {
    if (!this.candles.length) return [];
    const price = this.candles[this.candles.length - 1].close;
    const mid = (z) => (z.top + z.bottom) / 2;
    const pool = [
      ...this.overlays.obs.filter(o => !o.mitigated).map(o => ({ ...o, kindLabel: 'Order Block' })),
      ...this.overlays.fvgs.filter(f => !f.mitigated).map(f => ({ ...f, kindLabel: 'Fair Value Gap' }))
    ];
    const nearest = (arr) => arr.sort((a, b) => Math.abs(price - mid(a)) - Math.abs(price - mid(b)))[0];
    const below = nearest(pool.filter(z => z.type === 'bullish' && mid(z) < price));
    const above = nearest(pool.filter(z => z.type === 'bearish' && mid(z) > price));
    return [below && { ...below, dir: 'BUY' }, above && { ...above, dir: 'SELL' }].filter(Boolean);
  }

  _drawGrid(bounds) {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    const rows = 5;
    for (let i = 0; i <= rows; i++) {
      const y = this.margin.top + this._priceHeight() * (i / rows);
      ctx.beginPath();
      ctx.moveTo(this.margin.left, y);
      ctx.lineTo(this.w - this.margin.right, y);
      ctx.stroke();
    }
  }

  // Franja delgada arriba del gráfico (no un teñido de toda la altura, que
  // saturaba visualmente) — solo marca a qué sesión pertenece cada tramo.
  _drawSessions(start, end) {
    const ctx = this.ctx;
    const ribbonY = 4;
    const ribbonH = 5;
    const colors = { Asia: '#6478ff', Londres: '#ffb450', NY: '#50dc8c' };
    const sessionOf = (t) => {
      const h = new Date(t * 1000).getUTCHours();
      if (h >= 13 && h < 21) return 'NY';
      if (h >= 8 && h < 13) return 'Londres';
      return 'Asia';
    };
    let segStart = start;
    let curSession = sessionOf(this.candles[start].time);
    for (let i = start + 1; i <= end; i++) {
      const s = i < end ? sessionOf(this.candles[i].time) : null;
      if (s !== curSession) {
        const x1 = this.xForIndex(segStart, start) - this._candleStep() / 2;
        const x2 = this.xForIndex(i - 1, start) + this._candleStep() / 2;
        ctx.fillStyle = colors[curSession];
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x1, ribbonY, x2 - x1, ribbonH);
        ctx.globalAlpha = 1;
        if (x2 - x1 > 26) {
          ctx.fillStyle = 'rgba(230,230,235,0.4)';
          ctx.font = '9px Segoe UI, sans-serif';
          ctx.fillText(curSession, x1 + 3, ribbonY + ribbonH + 9);
        }
        segStart = i;
        curSession = s;
      }
    }
  }

  _drawVolume(start, end, step) {
    const ctx = this.ctx;
    const top = this.margin.top + this._priceHeight() + 4;
    const areaH = this._plotHeight() * VOLUME_RATIO - 4;
    if (areaH <= 0) return;
    let maxVol = 0;
    for (let i = start; i < end; i++) {
      const c = this.candles[i];
      if (c && c.volume > maxVol) maxVol = c.volume;
    }
    if (maxVol <= 0) return;
    const bodyW = Math.max(1, step * 0.62);
    for (let i = start; i < end; i++) {
      const c = this.candles[i];
      if (!c) continue;
      const x = this.xForIndex(i, start);
      const barH = (c.volume / maxVol) * areaH;
      ctx.fillStyle = c.close >= c.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)';
      ctx.fillRect(x - bodyW / 2, top + areaH - barH, bodyW, Math.max(1, barH));
    }
  }

  _drawCandles(start, end, bounds, step) {
    const ctx = this.ctx;
    const bodyW = Math.max(1, step * 0.62);
    for (let i = start; i < end; i++) {
      const c = this.candles[i];
      if (!c) continue;
      const x = this.xForIndex(i, start);
      const up = c.close >= c.open;
      ctx.strokeStyle = up ? '#26a69a' : '#ef5350';
      ctx.fillStyle = up ? '#26a69a' : '#ef5350';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, this.yForPrice(c.high, bounds));
      ctx.lineTo(x, this.yForPrice(c.low, bounds));
      ctx.stroke();
      const yO = this.yForPrice(Math.max(c.open, c.close), bounds);
      const yC = this.yForPrice(Math.min(c.open, c.close), bounds);
      ctx.fillRect(x - bodyW / 2, yO, bodyW, Math.max(1, yC - yO));
    }
  }

  _drawZones(list, start, end, bounds, kind) {
    const ctx = this.ctx;
    const MAX_SPAN = 40; // evita que una zona sin mitigar se estire por toda la pantalla
    for (const z of list) {
      if (z.index > end) continue;
      const naturalEnd = z.mitigated ? (z.mitigatedAt ?? end) : end;
      const zEndIndex = Math.min(naturalEnd, z.index + MAX_SPAN);
      if (zEndIndex < start && z.index < start) continue;
      const x1 = this.xForIndex(Math.max(z.index, start), start) - this._candleStep() / 2;
      const x2 = this.xForIndex(Math.min(zEndIndex, end - 1), start) + this._candleStep() / 2;
      const y1 = this.yForPrice(z.top, bounds);
      const y2 = this.yForPrice(z.bottom, bounds);
      const bull = z.type === 'bullish';
      let color;
      if (kind === 'ob') color = bull ? 'rgba(41,152,255,ALPHA)' : 'rgba(255,152,41,ALPHA)';
      else color = bull ? 'rgba(155,89,255,ALPHA)' : 'rgba(255,89,180,ALPHA)';
      const alpha = z.mitigated ? 0.06 : 0.16;
      ctx.fillStyle = color.replace('ALPHA', alpha);
      ctx.fillRect(x1, Math.min(y1, y2), Math.max(1, x2 - x1), Math.max(1, Math.abs(y2 - y1)));
      ctx.strokeStyle = color.replace('ALPHA', z.mitigated ? 0.15 : 0.5);
      ctx.strokeRect(x1, Math.min(y1, y2), Math.max(1, x2 - x1), Math.max(1, Math.abs(y2 - y1)));
    }
  }

  // Solo dibuja las líneas más cercanas al precio en vivo (en vez de las 10+
  // detectadas), más gruesas y con una etiqueta — así se distinguen de un
  // vistazo en lugar de perderse entre líneas punteadas parecidas.
  _drawHLines(list, bounds, kind) {
    const ctx = this.ctx;
    if (!list.length || !this.candles.length) return;
    const price = this.candles[this.candles.length - 1].close;
    const shown = kind === 'sr'
      ? [
          ...list.filter(l => l.price < price).sort((a, b) => b.price - a.price).slice(0, 2),
          ...list.filter(l => l.price >= price).sort((a, b) => a.price - b.price).slice(0, 2)
        ]
      : [
          ...list.filter(l => l.price < price).sort((a, b) => b.price - a.price).slice(0, 1),
          ...list.filter(l => l.price >= price).sort((a, b) => a.price - b.price).slice(0, 1)
        ];
    for (const l of shown) {
      if (l.price < bounds.min || l.price > bounds.max) continue;
      const y = this.yForPrice(l.price, bounds);
      let color, label;
      if (kind === 'sr') {
        // Soporte/resistencia se define por su posición respecto al precio EN VIVO
        // (piso si está debajo, techo si está encima) — no por el historial de toques,
        // que puede quedar "invertido" cuando el precio ya cruzó ese nivel.
        const isSupport = l.price < price;
        color = isSupport ? '#26a69a' : '#ef5350';
        label = `${isSupport ? 'SOPORTE' : 'RESISTENCIA'} ${l.price.toFixed(2)}`;
      } else {
        const isBuySide = l.type === 'SSL';
        color = isBuySide ? '#26a69a' : '#ef5350';
        label = `LIQUIDEZ ${l.type} ${l.price.toFixed(2)}`;
      }
      ctx.beginPath();
      ctx.setLineDash(kind === 'liq' ? [2, 3] : [6, 4]);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1.5;
      ctx.moveTo(this.margin.left, y);
      ctx.lineTo(this.w - this.margin.right, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      this._drawFlagLabel(this.margin.left + 4, y, label, color, '#0b0e14', 9);
    }
  }

  _drawKeyLevels(keyLevels, bounds) {
    const ctx = this.ctx;
    const x1 = this.margin.left, x2 = this.w - this.margin.right;
    const items = [
      ['pdh', keyLevels.pdh, '#ffca28', 'PDH'],
      ['pdl', keyLevels.pdl, '#ffca28', 'PDL'],
      ['asianHigh', keyLevels.asianHigh, '#4dd0e1', 'ASIA H'],
      ['asianLow', keyLevels.asianLow, '#4dd0e1', 'ASIA L']
    ];
    ctx.font = 'bold 9px Segoe UI, sans-serif';
    for (const [, price, color, label] of items) {
      if (price == null || price < bounds.min || price > bounds.max) continue;
      const y = this.yForPrice(price, bounds);
      ctx.beginPath();
      ctx.setLineDash([5, 3]);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.3;
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillText(label, x1 + 4, y - 3);
    }
  }

  _drawPremiumDiscount(pd, start, end, bounds) {
    const ctx = this.ctx;
    const x1 = this.margin.left, x2 = this.w - this.margin.right;
    const yTop = this.yForPrice(pd.top, bounds);
    const yEq = this.yForPrice(pd.eq, bounds);
    const yBottom = this.yForPrice(pd.bottom, bounds);
    ctx.fillStyle = 'rgba(239,83,80,0.045)';
    ctx.fillRect(x1, yTop, x2 - x1, Math.max(0, yEq - yTop));
    ctx.fillStyle = 'rgba(38,166,154,0.045)';
    ctx.fillRect(x1, yEq, x2 - x1, Math.max(0, yBottom - yEq));
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(x1, yEq); ctx.lineTo(x2, yEq); ctx.stroke();
    ctx.setLineDash([]);
  }

  _drawEvents(events, start, end, bounds) {
    const ctx = this.ctx;
    ctx.font = '10px Segoe UI, sans-serif';
    for (const ev of events) {
      if (ev.index < start || ev.index >= end) continue;
      const x = this.xForIndex(ev.index, start);
      const y = this.yForPrice(ev.price, bounds);
      ctx.fillStyle = ev.direction === 'bullish' ? '#26a69a' : '#ef5350';
      const label = ev.type;
      const tw = ctx.measureText(label).width;
      ctx.fillText(label, Math.min(this.w - this.margin.right - tw - 2, Math.max(this.margin.left, x - tw / 2)), y - 4);
    }
  }

  _drawSignals(signals, start, end, bounds) {
    const ctx = this.ctx;
    for (const s of signals) {
      if (s.index < start || s.index >= end || s.signal === 'NEUTRAL') continue;
      const x = this.xForIndex(s.index, start);
      const isBuy = s.signal === 'BUY';
      const color = isBuy ? '#26a69a' : '#ef5350';
      const c = this.candles[s.index];
      const arrowY = isBuy ? this.yForPrice(c.low, bounds) + 18 : this.yForPrice(c.high, bounds) - 18;
      ctx.fillStyle = color;
      ctx.strokeStyle = '#0b0e14';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (isBuy) {
        ctx.moveTo(x, arrowY + 10); ctx.lineTo(x - 9, arrowY - 7); ctx.lineTo(x + 9, arrowY - 7);
      } else {
        ctx.moveTo(x, arrowY - 10); ctx.lineTo(x - 9, arrowY + 7); ctx.lineTo(x + 9, arrowY + 7);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const labelY = isBuy ? arrowY + 22 : arrowY - 22;
      this._drawFlagLabel(x - 22, labelY, isBuy ? 'COMPRA' : 'VENTA', color, '#0b0e14', 10);
    }
  }

  _drawPriceAxis(bounds) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(230,230,235,0.65)';
    ctx.font = '10px Segoe UI, sans-serif';
    const rows = 5;
    for (let i = 0; i <= rows; i++) {
      const price = bounds.max - (bounds.max - bounds.min) * (i / rows);
      const y = this.margin.top + this._priceHeight() * (i / rows);
      ctx.fillText(price.toFixed(2), this.w - this.margin.right + 6, y + 3);
    }
  }

  _drawTimeAxis(start, end) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(230,230,235,0.55)';
    ctx.font = '10px Segoe UI, sans-serif';
    const step = this._candleStep();
    const labelCount = 6;
    const span = end - start;
    for (let k = 0; k < labelCount; k++) {
      const idx = start + Math.floor((span - 1) * (k / (labelCount - 1)));
      const c = this.candles[idx];
      if (!c) continue;
      const x = this.xForIndex(idx, start);
      const d = new Date(c.time * 1000);
      const label = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      ctx.fillText(label, x - 14, this.h - 8);
    }
  }

  _drawFlagLabel(x, y, text, bg, fg, fontSize = 10) {
    const ctx = this.ctx;
    ctx.font = `bold ${fontSize}px Segoe UI, sans-serif`;
    const paddingX = 6;
    const textW = ctx.measureText(text).width;
    const w = textW + paddingX * 2;
    const h = fontSize + 6;
    const top = y - h / 2, r = 3;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(x + r, top);
    ctx.arcTo(x + w, top, x + w, top + h, r);
    ctx.arcTo(x + w, top + h, x, top + h, r);
    ctx.arcTo(x, top + h, x, top, r);
    ctx.arcTo(x, top, x + w, top, r);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.fillText(text, x + paddingX, y + fontSize * 0.32);
    return w;
  }

  // Sin señal confirmada todavía: marca en ámbar (para no confundirse con el
  // verde/rojo de una señal real) la zona sin mitigar más cercana al precio
  // a cada lado, con el motivo (Order Block / FVG) directamente en la etiqueta.
  _drawPotentialEntries(potentials, bounds) {
    const ctx = this.ctx;
    const x1 = this.margin.left;
    const x2 = this.w - this.margin.right;
    const pulse = (Math.sin(Date.now() / 500) + 1) / 2;
    for (const p of potentials) {
      const yTop = this.yForPrice(p.top, bounds);
      const yBottom = this.yForPrice(p.bottom, bounds);
      const rectTop = Math.min(yTop, yBottom);
      const rectH = Math.max(2, Math.abs(yBottom - yTop));

      ctx.fillStyle = `rgba(255,202,40,${(0.08 + pulse * 0.05).toFixed(3)})`;
      ctx.fillRect(x1, rectTop, x2 - x1, rectH);
      ctx.strokeStyle = `rgba(255,202,40,${(0.55 + pulse * 0.25).toFixed(3)})`;
      ctx.setLineDash([5, 3]);
      ctx.lineWidth = 1.4;
      ctx.strokeRect(x1, rectTop, x2 - x1, rectH);
      ctx.setLineDash([]);

      const label = `POSIBLE ${p.dir === 'BUY' ? 'COMPRA' : 'VENTA'} — ${p.kindLabel} sin mitigar`;
      this._drawFlagLabel(x1 + 4, (yTop + yBottom) / 2, label, '#ffca28', '#3a2f0f', 10);
    }
  }

  _drawTradePlan(plan, bounds) {
    const ctx = this.ctx;
    const x1 = this.margin.left;
    const x2 = this.w - this.margin.right;
    const flagX = x1 + 4;
    const isBuy = plan.direction === 'BUY';
    const [dr, dg, db] = isBuy ? [38, 166, 154] : [239, 83, 80];

    // Zona de entrada: banda dinámica, con degradado y pulso que se intensifica
    // cuando el precio en vivo ya está dentro de la zona (vs. "esperando").
    const [zBottom, zTop] = plan.entryZone;
    const yTop = this.yForPrice(zTop, bounds);
    const yBottom = this.yForPrice(zBottom, bounds);
    const rectTop = Math.min(yTop, yBottom);
    const rectH = Math.max(2, Math.abs(yBottom - yTop));

    const liveClose = this.candles.length ? this.candles[this.candles.length - 1].close : null;
    const priceInZone = liveClose != null && liveClose >= zBottom && liveClose <= zTop;
    const pulse = (Math.sin(Date.now() / 260) + 1) / 2; // 0..1, respiración continua

    const fillAlpha = priceInZone ? 0.16 + pulse * 0.16 : 0.07;
    const borderAlpha = priceInZone ? 0.6 + pulse * 0.35 : 0.4;

    const grad = ctx.createLinearGradient(0, rectTop, 0, rectTop + rectH);
    grad.addColorStop(0, `rgba(${dr},${dg},${db},${fillAlpha * 0.5})`);
    grad.addColorStop(0.5, `rgba(${dr},${dg},${db},${fillAlpha})`);
    grad.addColorStop(1, `rgba(${dr},${dg},${db},${fillAlpha * 0.5})`);
    ctx.fillStyle = grad;
    ctx.fillRect(x1, rectTop, x2 - x1, rectH);

    ctx.strokeStyle = `rgba(${dr},${dg},${db},${borderAlpha})`;
    ctx.lineWidth = priceInZone ? 2 : 1;
    ctx.setLineDash(priceInZone ? [] : [4, 3]);
    ctx.strokeRect(x1, rectTop, x2 - x1, rectH);
    ctx.setLineDash([]);

    const widthPts = Math.abs(zTop - zBottom);
    const statusText = priceInZone ? '● EN ZONA AHORA' : 'esperando retroceso';
    const zoneLabel = `ENTRY (${plan.entryZoneSource}) Δ${widthPts.toFixed(2)} · ${statusText}`;
    this._drawFlagLabel(
      flagX, (yTop + yBottom) / 2, zoneLabel,
      priceInZone ? `rgb(${dr},${dg},${db})` : '#c9ccd6',
      priceInZone ? '#ffffff' : '#0b0e14',
      priceInZone ? 11 : 10
    );

    // Nivel inválido (SL)
    const ySL = this.yForPrice(plan.sl, bounds);
    ctx.strokeStyle = '#ef5350';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x1, ySL); ctx.lineTo(x2, ySL); ctx.stroke();
    ctx.setLineDash([]);
    this._drawFlagLabel(flagX, ySL, 'INVALID LEVEL', '#ef5350', '#ffffff');

    // Take profits
    [['tp1', 'TP1'], ['tp2', 'TP2'], ['tp3', 'TP3']].forEach(([key, label]) => {
      const p = plan[key];
      if (p == null || !isFinite(p)) return;
      const y = this.yForPrice(p, bounds);
      ctx.strokeStyle = 'rgba(38,166,154,0.75)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
      this._drawFlagLabel(flagX, y, label, '#26a69a', '#06231f');
    });
  }

  _drawCurrentPriceLine(bounds) {
    if (!this.candles.length) return;
    const ctx = this.ctx;
    const last = this.candles[this.candles.length - 1];
    const y = this.yForPrice(last.close, bounds);
    const up = last.close >= last.open;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.setLineDash([2, 2]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.margin.left, y);
    ctx.lineTo(this.w - this.margin.right, y);
    ctx.stroke();
    ctx.setLineDash([]);

    const text = last.close.toFixed(2);
    ctx.font = 'bold 11px Segoe UI, sans-serif';
    const boxX = this.w - this.margin.right;
    const boxW = this.margin.right - 2;
    ctx.fillStyle = up ? '#26a69a' : '#ef5350';
    ctx.fillRect(boxX, y - 9, boxW, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, boxX + 4, y + 4);
  }
}

window.CandleChart = CandleChart;
