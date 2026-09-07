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
    this.margin = { top: 14, right: 72, bottom: 26, left: 8 };
    this.dpr = window.devicePixelRatio || 1;

    this._bindEvents();
    this.resize();

    // Loop de animación liviano: solo vuelve a dibujar (para el pulso de la
    // Entry Zone) mientras haya un plan de trade activo visible.
    setInterval(() => {
      if (this.overlays.tradePlan && this.toggles.tradePlan) this.render();
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
    const plan = this.toggles.tradePlan ? this.overlays.tradePlan : null;
    if (plan) bounds = this._expandBoundsForPlan(bounds, plan);
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
    this._drawPriceAxis(bounds);
    this._drawCurrentPriceLine(bounds);
    this._drawTimeAxis(start, end);
  }

  _expandBoundsForPlan(bounds, plan) {
    const values = [plan.sl, plan.tp1, plan.tp2, plan.tp3, plan.entryZone[0], plan.entryZone[1]].filter(v => isFinite(v));
    if (!values.length) return bounds;
    let min = Math.min(bounds.min, ...values);
    let max = Math.max(bounds.max, ...values);
    const pad = (max - min) * 0.04;
    return { min: min - pad, max: max + pad };
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

  _drawSessions(start, end) {
    const ctx = this.ctx;
    const top = this.margin.top;
    const bottom = this.margin.top + this._plotHeight();
    const colors = { Asia: 'rgba(100,120,255,0.05)', Londres: 'rgba(255,180,80,0.05)', NY: 'rgba(80,220,140,0.05)' };
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
        ctx.fillRect(x1, top, x2 - x1, bottom - top);
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '9px Segoe UI, sans-serif';
        ctx.fillText(curSession, x1 + 3, top + 10);
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
    for (const z of list) {
      if (z.index > end) continue;
      const zEndIndex = z.mitigated ? (z.mitigatedAt ?? end) : end;
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

  _drawHLines(list, bounds, kind) {
    const ctx = this.ctx;
    for (const l of list) {
      if (l.price < bounds.min || l.price > bounds.max) continue;
      const y = this.yForPrice(l.price, bounds);
      ctx.beginPath();
      ctx.setLineDash(kind === 'liq' ? [2, 3] : [6, 4]);
      if (kind === 'sr') {
        const isSupport = l.lowTouches >= l.highTouches;
        ctx.strokeStyle = isSupport ? 'rgba(38,166,154,0.55)' : 'rgba(239,83,80,0.55)';
      } else {
        ctx.strokeStyle = l.type === 'SSL' ? 'rgba(38,166,154,0.4)' : 'rgba(239,83,80,0.4)';
      }
      ctx.lineWidth = 1;
      ctx.moveTo(this.margin.left, y);
      ctx.lineTo(this.w - this.margin.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
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
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
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
      const c = this.candles[s.index];
      const y = isBuy ? this.yForPrice(c.low, bounds) + 14 : this.yForPrice(c.high, bounds) - 14;
      ctx.fillStyle = isBuy ? '#26a69a' : '#ef5350';
      ctx.beginPath();
      if (isBuy) {
        ctx.moveTo(x, y + 7); ctx.lineTo(x - 6, y - 5); ctx.lineTo(x + 6, y - 5);
      } else {
        ctx.moveTo(x, y - 7); ctx.lineTo(x - 6, y + 5); ctx.lineTo(x + 6, y + 5);
      }
      ctx.closePath();
      ctx.fill();
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
