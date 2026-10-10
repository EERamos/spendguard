// SpendGuard dashboard: vanilla JS, no build step. Talks to the SpendGuard API on the same origin.

const POLL_MS = 3000;

const STATUS = {
  DENIED: 'Denegada',
  PENDING_APPROVAL: 'Pendiente de aprobación',
  REJECTED: 'Rechazada',
  AWAITING_PAYMENT: 'Esperando pago',
  COMPLETED: 'Completada',
  FAILED: 'Fallida',
  EXPIRED: 'Expirada',
  CANCELLED: 'Cancelada',
};
const OUTCOME = { AUTO_APPROVE: 'Autoaprobada', REQUIRE_APPROVAL: 'Requiere aprobación', DENY: 'Denegada' };
const EVENT = {
  REQUEST_CREATED: ['Solicitud creada', ''],
  QUOTE_CREATED: ['Cotización creada en Reap', 'info'],
  QUOTE_REFRESHED: ['Cotización renovada', 'info'],
  QUOTE_FAILED: ['Falló la cotización', 'bad'],
  POLICY_EVALUATED: ['Política evaluada', ''],
  APPROVAL_REQUESTED: ['Aprobación solicitada', 'warn'],
  AUTO_APPROVED: ['Autoaprobada por política', 'ok'],
  APPROVED: ['Aprobada', 'ok'],
  APPROVAL_BLOCKED: ['Aprobación bloqueada por política', 'bad'],
  PRICE_CHANGED: ['El precio cambió', 'warn'],
  REJECTED: ['Rechazada', 'bad'],
  CANCELLED: ['Cancelada', ''],
  CHECKOUT_CREATED: ['Checkout abierto en Reap', 'info'],
  CHECKOUT_FAILED: ['Falló el checkout', 'bad'],
  CHECKOUT_STATUS: ['Estado del checkout', 'info'],
  RECONCILED: ['Conciliada', 'ok'],
  RECONCILIATION_VARIANCE: ['Variación en conciliación', 'warn'],
  POLICY_UPDATED: ['Política actualizada', 'warn'],
};
const FILTERS = [
  ['all', 'Todas', null],
  ['pending', 'Pendientes', ['PENDING_APPROVAL']],
  ['payment', 'Esperando pago', ['AWAITING_PAYMENT']],
  ['done', 'Completadas', ['COMPLETED']],
  ['closed', 'Denegadas / otras', ['DENIED', 'REJECTED', 'FAILED', 'EXPIRED', 'CANCELLED']],
];
// Shown only while the conversation is empty and an agent is connected.
const SUGGESTIONS = ['Compra 2 power banks de menos de 100 dólares para el equipo de soporte'];
const DEFAULT_USERS = ['ana@acme.test', 'luis@acme.test', 'sofia@acme.test'];

const state = {
  health: null,
  policy: null,
  budgets: [],
  requests: [],
  filter: 'all',
  selectedId: null,
  selected: null, // { request, audit }
  detailSig: '',
  listSig: '',
  budgetSig: '',
  auditSig: '',
  audit: [],
  chat: { messages: [], history: [] },
  chatBusy: false,
  policyDirty: false,
};

// ---------------------------------------------------------------- utils

const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtNum = (n) => Number(n ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney = (m) => (m ? `${fmtNum(m.amount)} ${m.currency}` : '–');
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'medium' }) : '');
const badge = (status) => `<span class="badge s-${esc(status)}">${esc(STATUS[status] ?? status)}</span>`;
const outcomeBadge = (o) => `<span class="badge o-${esc(o)}">${esc(OUTCOME[o] ?? o)}</span>`;

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: keep working without it */
    }
  },
};
const session = {
  get(key) {
    try {
      const v = sessionStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};

/** Tiny safe formatter for agent replies: escapes, then links URLs, bolds **text**, keeps line breaks. */
function richText(text) {
  let html = esc(text);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(https?:\/\/[^\s<)"]+)/g, (url) => {
    const clean = url.replace(/[.,;:]+$/, '');
    const tail = url.slice(clean.length);
    return `<a href="${clean}">${clean}</a>${tail}`;
  });
  return html.replace(/\n/g, '<br>');
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: { message: text } };
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Error ${res.status}`);
    err.code = data?.error?.code;
    err.status = res.status;
    err.issues = data?.error?.issues;
    throw err;
  }
  return data;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 4000);
}

const actor = () => $('#actor').value.trim().toLowerCase();
const department = () => $('#department').value;

// ---------------------------------------------------------------- header / session

function renderChips() {
  const h = state.health;
  if (!h) return;
  const reap = h.reapMode === 'live' ? '<span class="chip live"><span class="dot"></span>Reap sandbox (live)</span>' : '<span class="chip mock"><span class="dot"></span>Reap simulado (mock)</span>';
  const agent = `<span class="chip"><span class="dot" style="background:${h.agentMode === 'none' ? 'var(--idle)' : 'var(--accent)'}"></span>Agente: ${h.agentMode === 'none' ? 'no conectado' : esc(h.agentMode)}</span>`;
  $('#mode-chips').innerHTML = reap + agent + `<span class="chip">Política v${esc(h.policyVersion)}</span>`;
  $('#agent-chip').textContent = h.agentMode === 'none' ? 'No conectado' : h.agentMode;
  if (state.renderedAgentMode !== h.agentMode) {
    state.renderedAgentMode = h.agentMode;
    renderChat();
  }
}

function renderSessionOptions() {
  const p = state.policy;
  if (!p) return;
  const sel = $('#department');
  const saved = store.get('sg.department', sel.value || Object.keys(p.departments)[0]);
  sel.innerHTML = Object.entries(p.departments)
    .map(([id, d]) => `<option value="${esc(id)}">${esc(d.name)} (${esc(id)})</option>`)
    .join('');
  sel.value = p.departments[saved] ? saved : Object.keys(p.departments)[0];

  const approvers = Object.values(p.departments).flatMap((d) => d.approvers);
  const users = [...new Set([...DEFAULT_USERS, ...approvers])];
  $('#known-users').innerHTML = users.map((u) => `<option value="${esc(u)}"></option>`).join('');
  renderChatContext();
}

function renderChatContext() {
  const p = state.policy;
  const d = p?.departments?.[department()];
  const isApprover = d?.approvers?.map((a) => a.toLowerCase()).includes(actor());
  $('#chat-context').innerHTML = d
    ? `El agente compra a nombre de <strong>${esc(actor() || '¿quién?')}</strong> para <strong>${esc(d.name)}</strong>` +
      (isApprover ? ' · eres aprobador de este departamento' : '')
    : '';
}

// ---------------------------------------------------------------- budgets

function renderBudgets() {
  const sig = JSON.stringify(state.budgets) + department();
  if (sig === state.budgetSig) return;
  state.budgetSig = sig;
  $('#budgets').innerHTML = state.budgets
    .map((b) => {
      const total = b.monthlyBudget || 1;
      const cPct = Math.min(100, (b.committed / total) * 100);
      const rPct = Math.min(100 - cPct, (b.reserved / total) * 100);
      const low = b.remaining < b.monthlyBudget * 0.15;
      return `<article class="card budget ${b.departmentId === department() ? 'mine' : ''}">
        <div class="budget-top"><h3>${esc(b.name)}</h3><span class="muted small">${esc(b.month)}</span></div>
        <div class="budget-remaining num" style="${low ? 'color:var(--bad)' : ''}">${fmtNum(b.remaining)} <small>${esc(b.currency)} disponibles</small></div>
        <div class="bar" role="img" aria-label="Gastado ${fmtNum(b.committed)}, reservado ${fmtNum(b.reserved)} de ${fmtNum(b.monthlyBudget)}">
          <span class="committed" style="width:${cPct}%"></span><span class="reserved" style="width:${rPct}%"></span>
        </div>
        <div class="legend num">
          <span><i class="c"></i>Gastado ${fmtNum(b.committed)}</span>
          <span><i class="r"></i>Reservado ${fmtNum(b.reserved)}</span>
          <span><i class="f"></i>de ${fmtNum(b.monthlyBudget)}</span>
        </div>
        <div class="budget-rules">Autoaprueba ≤ ${fmtNum(b.autoApproveUnder)} · tope ${fmtNum(b.hardCapPerPurchase)} · aprueba ${esc(b.approvers.join(', ') || 'cualquiera')}</div>
      </article>`;
    })
    .join('');
}

// ---------------------------------------------------------------- requests

function renderFilters() {
  const counts = Object.fromEntries(
    FILTERS.map(([key, , statuses]) => [key, statuses ? state.requests.filter((r) => statuses.includes(r.status)).length : state.requests.length]),
  );
  $('#filters').innerHTML = FILTERS.map(
    ([key, label]) =>
      `<button class="filter ${state.filter === key ? 'active' : ''}" data-filter="${key}" role="tab" aria-selected="${state.filter === key}">${label}<span class="count">${counts[key]}</span></button>`,
  ).join('');
}

function renderRequests() {
  const sig = JSON.stringify(state.requests.map((r) => [r.id, r.updatedAt])) + state.filter + state.selectedId;
  if (sig === state.listSig) return;
  state.listSig = sig;
  renderFilters();
  const statuses = FILTERS.find(([k]) => k === state.filter)?.[2];
  const rows = statuses ? state.requests.filter((r) => statuses.includes(r.status)) : state.requests;
  $('#requests-empty').hidden = rows.length > 0;
  const depts = state.policy?.departments ?? {};
  $('#requests-body').innerHTML = rows
    .map(
      (r) => `<tr data-id="${esc(r.id)}" class="${r.id === state.selectedId ? 'selected' : ''}">
        <td class="num muted">${fmtTime(r.createdAt)}</td>
        <td><div class="product">${esc(r.item.productName)}${r.item.quantity > 1 ? ` <span class="muted">×${r.item.quantity}</span>` : ''}</div><div class="muted small">${esc(r.item.merchant)}</div></td>
        <td>${esc(depts[r.departmentId]?.name ?? r.departmentId)}</td>
        <td class="small">${esc(r.requester.email)}</td>
        <td class="r num">${fmtMoney(r.checkout?.finalAmount ?? r.quote.total)}</td>
        <td>${badge(r.status)}${r.reconciliation?.flagged ? ' <span class="badge s-PENDING_APPROVAL" title="El cargo final difiere de la cotización">Variación</span>' : ''}</td>
      </tr>`,
    )
    .join('');
}

// ---------------------------------------------------------------- detail

function renderPlaceholder() {
  $('#detail').innerHTML = `<div class="card-head"><h2>Detalle</h2></div>
    <div class="placeholder">
      <h3>Cómo funciona</h3>
      <ol class="flow">
        <li>El agente busca productos en los comercios de Reap y pide una compra.</li>
        <li>SpendGuard cotiza con Reap y aplica la política: <strong>autoaprueba</strong>, pide <strong>aprobación interna</strong> o <strong>deniega</strong>.</li>
        <li>Solo si está permitido se crea el checkout de Reap: el titular de la tarjeta aprueba el cargo en la página de Reap.</li>
        <li>Al volver, SpendGuard consulta a Reap y <strong>concilia</strong> el cargo final contra la cotización.</li>
      </ol>
      <p class="muted small">Selecciona una solicitud para ver la decisión, la cotización y la auditoría.</p>
    </div>`;
}

function hitList(hits) {
  return `<ul class="hits">${hits
    .map((h) => `<li class="hit ${esc(h.outcome)}"><div>${esc(h.message)}</div><div class="rule">${esc(h.rule)} · ${esc(OUTCOME[h.outcome] ?? h.outcome)}</div></li>`)
    .join('')}</ul>`;
}

function quoteTable(q) {
  const b = q.breakdown;
  const rows = [['Subtotal', b.itemsSubtotal]];
  if (b.shipping) rows.push(['Envío', b.shipping]);
  if (b.tax?.amount) rows.push([b.tax.includedInPrices ? 'Impuestos (incluidos)' : 'Impuestos', b.tax.amount]);
  for (const d of b.discounts ?? []) rows.push([`Descuento ${d.name}`, { ...d.amount, amount: -Math.abs(d.amount.amount) }]);
  for (const c of b.additionalCharges ?? []) rows.push([c.name, c.amount]);
  const ship = (q.shippingOptions ?? []).find((o) => o.selected);
  return `<table class="kv">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmtMoney(v)}</td></tr>`).join('')}
    <tr class="total"><td>Total cotizado</td><td>${fmtMoney(b.finalAmount)}</td></tr></table>
    <div class="muted small" style="margin-top:6px">Cotización <span class="mono">${esc(q.id)}</span> (intento ${esc(q.attempt)})${ship ? ` · ${esc(ship.name)}` : ''} · expira ${fmtTime(q.expiresAt)}</div>`;
}

function actionsSection(r) {
  const dept = state.policy?.departments?.[r.departmentId];
  const approvers = dept?.approvers ?? [];
  if (r.status === 'PENDING_APPROVAL') {
    const me = actor();
    const canApprove = approvers.length === 0 || approvers.map((a) => a.toLowerCase()).includes(me);
    const self = me === r.requester.email.toLowerCase();
    let hint = `Aprueba: <strong>${esc(approvers.join(', ') || 'cualquiera')}</strong>. Estás actuando como <strong>${esc(me || '–')}</strong>.`;
    if (!canApprove) hint += ' No eres aprobador de este departamento: cambia "Actuando como" para aprobar.';
    else if (self && !state.policy?.allowSelfApproval) hint += ' No puedes aprobar tu propia solicitud.';
    return `<div class="section"><h3>Aprobación interna</h3>
      <div class="callout warn">${hint}</div>
      <div class="stack" style="margin-top:10px">
        <textarea class="note" id="action-note" placeholder="Nota para aprobar o motivo del rechazo"></textarea>
        <div class="btn-row">
          <button class="btn ok" data-action="approve">Aprobar</button>
          <button class="btn danger" data-action="reject">Rechazar</button>
          <button class="btn ghost" data-action="cancel">Cancelar solicitud</button>
        </div>
      </div></div>`;
  }
  if (r.status === 'AWAITING_PAYMENT') {
    const url = r.checkout?.paymentUrl;
    return `<div class="section"><h3>Pago en Reap</h3>
      <div class="callout info">Checkout <span class="mono">${esc(r.checkout?.id)}</span> en estado <strong>${esc(r.checkout?.status)}</strong>.
      El titular de la tarjeta revisa y autoriza el cargo en la página de Reap; ni SpendGuard ni el agente ven datos de tarjeta.</div>
      <div class="stack" style="margin-top:10px">
        ${url ? `<a class="btn primary big" href="${esc(url)}">Abrir página de pago de Reap</a>` : ''}
        <div class="btn-row"><button class="btn" data-action="refresh">Consultar estado en Reap</button></div>
        ${r.checkout?.paymentUrlExpiresAt ? `<div class="muted small">El link expira ${fmtDateTime(r.checkout.paymentUrlExpiresAt)}</div>` : ''}
      </div></div>`;
  }
  return '';
}

function outcomeSection(r) {
  const parts = [];
  if (r.approval) {
    parts.push(`<div class="callout ok">Aprobada por <strong>${esc(r.approval.by)}</strong> ${fmtDateTime(r.approval.at)} por ${fmtMoney(r.approval.approvedTotal)}${r.approval.note ? `: “${esc(r.approval.note)}”` : ''}</div>`);
  }
  if (r.rejection) {
    parts.push(`<div class="callout bad">Rechazada por <strong>${esc(r.rejection.by)}</strong> ${fmtDateTime(r.rejection.at)}: “${esc(r.rejection.reason)}”</div>`);
  }
  if (r.failure) parts.push(`<div class="callout bad"><strong>${esc(r.failure.code)}</strong>: ${esc(r.failure.message)}</div>`);
  if (r.status === 'COMPLETED' && r.reconciliation) {
    const rec = r.reconciliation;
    parts.push(`<table class="kv">
        <tr><td>Cotizado</td><td>${fmtNum(rec.quotedTotal)} ${esc(rec.currency)}</td></tr>
        <tr><td>Cobrado por Reap</td><td>${fmtMoney(r.checkout?.finalAmount)}</td></tr>
        <tr class="total"><td>Variación</td><td>${rec.variance > 0 ? '+' : ''}${fmtNum(rec.variance)}</td></tr>
      </table>
      <div class="callout ${rec.flagged ? 'warn' : 'ok'}">${rec.flagged ? 'El cargo final excede la tolerancia de conciliación: revisar con el merchant.' : 'Conciliado: el cargo final coincide con la cotización.'}${r.checkout?.orderId ? ` Orden <span class="mono">${esc(r.checkout.orderId)}</span>.` : ''}</div>`);
  }
  if (parts.length === 0) return '';
  return `<div class="section"><h3>${r.status === 'COMPLETED' ? 'Conciliación' : 'Resultado'}</h3>${parts.join('')}</div>`;
}

function eventSummary(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case 'REQUEST_CREATED':
      return d.item ? `${d.item.productName} ×${d.item.quantity} · ${d.departmentId}` : '';
    case 'QUOTE_CREATED':
      return `${fmtMoney(d.total)} · ${d.quoteId ?? ''}`;
    case 'QUOTE_REFRESHED':
      return `${fmtMoney(d.oldTotal)} → ${fmtMoney(d.newTotal)}`;
    case 'POLICY_EVALUATED':
      return `${OUTCOME[d.outcome] ?? d.outcome} · v${d.policyVersion}${d.trigger ? ' · al aprobar' : ''}`;
    case 'APPROVAL_REQUESTED':
      return `Aprobadores: ${(d.approvers ?? []).join(', ') || 'cualquiera'}`;
    case 'APPROVED':
      return `${fmtMoney(d.approvedTotal)}${d.note ? ` · “${d.note}”` : ''}`;
    case 'REJECTED':
      return d.reason ?? '';
    case 'APPROVAL_BLOCKED':
      return (d.reasons ?? []).join('; ');
    case 'CHECKOUT_CREATED':
      return `${d.checkoutId} · ${d.status}`;
    case 'CHECKOUT_STATUS':
      return `${d.from ?? '–'} → ${d.to}`;
    case 'CHECKOUT_FAILED':
    case 'QUOTE_FAILED':
      return d.message ?? d.code ?? '';
    case 'RECONCILED':
      return `Cotizado ${fmtMoney(d.quoted)} · cobrado ${fmtMoney(d.final)}${d.orderId ? ` · ${d.orderId}` : ''}`;
    case 'RECONCILIATION_VARIANCE':
      return `Variación ${fmtNum(d.variance)} (tolerancia ${d.tolerancePct}%)`;
    case 'PRICE_CHANGED':
      return `${fmtMoney(d.approvedTotal)} → ${fmtMoney(d.newTotal)}`;
    case 'POLICY_UPDATED':
      return `v${d.fromVersion} → v${d.toVersion}`;
    default:
      return '';
  }
}

function timeline(events) {
  return `<ul class="timeline">${events
    .map((e) => {
      const [label, tone] = EVENT[e.type] ?? [e.type, ''];
      const summary = eventSummary(e);
      return `<li class="${tone ? `ev-${tone}` : ''}"><div class="t-type">${esc(label)}</div>
        <div class="t-meta">${fmtDateTime(e.at)} · ${esc(e.actor)}</div>${summary ? `<div class="t-data">${esc(summary)}</div>` : ''}</li>`;
    })
    .join('')}</ul>`;
}

function renderDetail(force = false) {
  if (!state.selected) {
    if (state.detailSig !== 'none') {
      state.detailSig = 'none';
      renderPlaceholder();
    }
    return;
  }
  const { request: r, audit } = state.selected;
  const sig = `${r.id}|${r.updatedAt}|${audit.length}|${actor()}|${state.policy?.version}`;
  if (!force && sig === state.detailSig) return;
  // Keep what the approver is typing across polls.
  const note = $('#action-note')?.value ?? '';
  state.detailSig = sig;
  const dept = state.policy?.departments?.[r.departmentId];
  const budget = r.decision.budget;

  $('#detail').innerHTML = `
    <div class="card-head">${badge(r.status)}<span class="mono muted">${esc(r.id)}</span>
      <button class="btn ghost spacer" data-action="close" title="Cerrar">Cerrar</button></div>
    <div class="card-body" style="padding-bottom:12px">
      <div class="detail-title">${esc(r.item.productName)}${r.item.quantity > 1 ? ` <span class="muted">×${r.item.quantity}</span>` : ''}</div>
      <div class="muted">${esc(r.item.merchant)} · ${fmtMoney(r.item.unitPrice)} c/u</div>
      <dl class="meta">
        <dt>Solicitante</dt><dd>${esc(r.requester.email)}</dd>
        <dt>Departamento</dt><dd>${esc(dept?.name ?? r.departmentId)}</dd>
        <dt>Creada</dt><dd>${fmtDateTime(r.createdAt)}</dd>
        <dt>Justificación</dt><dd>${esc(r.justification || '–')}</dd>
        ${r.declaredMaxTotal !== undefined ? `<dt>Máximo declarado</dt><dd>${fmtNum(r.declaredMaxTotal)}</dd>` : ''}
      </dl>
    </div>
    <div class="section"><h3>Decisión de la política ${outcomeBadge(r.decision.outcome)}<span class="muted" style="text-transform:none;letter-spacing:0">v${esc(r.decision.policyVersion)}</span></h3>
      ${hitList(r.decision.hits)}
      ${budget ? `<div class="muted small" style="margin-top:8px">Presupuesto ${esc(dept?.name ?? r.departmentId)}: disponible ${fmtNum(budget.remainingBefore)} → ${fmtNum(budget.remainingAfter)} ${esc(budget.currency)} tras esta compra</div>` : ''}
    </div>
    <div class="section"><h3>Cotización de Reap</h3>${quoteTable(r.quote)}</div>
    ${actionsSection(r)}
    ${outcomeSection(r)}
    <div class="section"><h3>Auditoría</h3>${timeline(audit)}</div>`;
  const noteEl = $('#action-note');
  if (noteEl && note) noteEl.value = note;
}

async function loadSelected() {
  if (!state.selectedId) {
    state.selected = null;
    renderDetail();
    return;
  }
  try {
    state.selected = await api('GET', `/api/requests/${encodeURIComponent(state.selectedId)}`);
  } catch (e) {
    if (e.status === 404) {
      toast(`La solicitud ${state.selectedId} no existe`, 'bad');
      select(null);
      return;
    }
    throw e;
  }
  renderDetail();
}

function select(id) {
  const target = id ? `#/requests/${id}` : '#/';
  if (location.hash !== target) history.replaceState(null, '', target);
  state.selectedId = id;
  state.listSig = '';
  renderRequests();
  loadSelected().catch((e) => toast(e.message, 'bad'));
  if (id && window.matchMedia('(max-width: 1420px)').matches) {
    $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function routeFromHash() {
  const m = /^#\/requests\/([^/?#]+)/.exec(location.hash);
  const id = m ? decodeURIComponent(m[1]) : null;
  if (id !== state.selectedId) select(id);
}

async function runAction(action) {
  const r = state.selected?.request;
  if (!r) return;
  const note = $('#action-note')?.value.trim() ?? '';
  const who = actor();
  try {
    let res;
    if (action === 'approve') res = await api('POST', `/api/requests/${r.id}/approve`, { actor: who, ...(note ? { note } : {}) });
    else if (action === 'reject') {
      if (!note) {
        toast('Escribe el motivo del rechazo', 'bad');
        $('#action-note')?.focus();
        return;
      }
      res = await api('POST', `/api/requests/${r.id}/reject`, { actor: who, reason: note });
    } else if (action === 'cancel') res = await api('POST', `/api/requests/${r.id}/cancel`, { actor: who });
    else if (action === 'refresh') res = await api('POST', `/api/requests/${r.id}/refresh`);
    const after = res?.request;
    if (after) {
      const msg = {
        approve: after.status === 'AWAITING_PAYMENT' ? 'Aprobada: se abrió el checkout de Reap' : `Resultado: ${STATUS[after.status] ?? after.status}`,
        reject: 'Solicitud rechazada',
        cancel: 'Solicitud cancelada',
        refresh: `Estado en Reap: ${after.checkout?.status ?? after.status}`,
      }[action];
      toast(msg, after.status === 'DENIED' || after.status === 'FAILED' ? 'bad' : 'ok');
    }
    await refreshAll();
    await loadSelected();
    renderDetail(true);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

// ---------------------------------------------------------------- chat

function renderChat() {
  const log = $('#chat-log');
  const msgs = state.chat.messages;
  if (msgs.length === 0 && !state.chatBusy) {
    log.innerHTML =
      state.health?.agentMode === 'none'
        ? `<div class="msg agent"><div class="who">Agente</div>El agente de compras todavía no está conectado. Mientras tanto, las solicitudes llegan por
      <span class="mono">POST /api/requests</span>; cuando tu agente implemente la interfaz <span class="mono">Agent</span> (src/agent/types.ts), conversará aquí con la misma política.</div>`
        : `<div class="msg agent"><div class="who">Agente</div>Hola. Dime qué necesitas comprar y lo gestiono con la política de la empresa.
      Nunca pago ni veo tarjetas: si la compra procede, te doy el link de pago de Reap.</div>`;
  } else {
    log.innerHTML =
      msgs
        .map((m) => {
          if (m.role === 'user') return `<div class="msg user">${esc(m.text)}</div>`;
          const minis = (m.requests ?? [])
            .map(
              (r) => `<a class="mini" href="#/requests/${esc(r.id)}"><span>${esc(r.item.productName)}${r.item.quantity > 1 ? ` ×${r.item.quantity}` : ''} · <span class="num">${fmtMoney(r.quote.total)}</span></span>${badge(r.status)}</a>`,
            )
            .join('');
          return `<div class="msg agent"><div class="who">Agente${m.mode && m.mode !== 'none' ? ` · ${esc(m.mode)}` : ''}</div>${richText(m.text)}${minis ? `<div class="req-mini">${minis}</div>` : ''}</div>`;
        })
        .join('') + (state.chatBusy ? '<div class="msg agent pending">Pensando y consultando la política…</div>' : '');
  }
  log.scrollTop = log.scrollHeight;
  $('#chat-send').disabled = state.chatBusy;
  $('#suggestions').innerHTML =
    msgs.length === 0 && state.health && state.health.agentMode !== 'none' ? SUGGESTIONS.map((s) => `<button class="suggestion" type="button" data-suggest="${esc(s)}">${esc(s)}</button>`).join('') : '';
}

async function sendChat(text) {
  const message = text.trim();
  if (!message || state.chatBusy) return;
  if (!actor()) {
    toast('Indica en "Actuando como" a nombre de quién compra el agente', 'bad');
    $('#actor').focus();
    return;
  }
  state.chat.messages.push({ role: 'user', text: message });
  state.chatBusy = true;
  renderChat();
  try {
    const res = await api('POST', '/api/agent/chat', {
      message,
      requesterEmail: actor(),
      departmentId: department(),
      history: state.chat.history,
    });
    state.chat.history = res.history ?? [];
    state.chat.messages.push({ role: 'agent', text: res.reply, requests: res.requests ?? [], mode: res.mode });
    if (res.requestIds?.length) {
      await refreshAll();
      select(res.requestIds[res.requestIds.length - 1]);
    }
  } catch (e) {
    state.chat.messages.push({ role: 'agent', text: `No pude completar la solicitud: ${e.message}` });
  } finally {
    state.chatBusy = false;
    session.set('sg.chat', state.chat);
    renderChat();
  }
}

// ---------------------------------------------------------------- policy

function renderPolicyEditor(force = false) {
  if (!state.policy) return;
  $('#policy-version').textContent = `v${state.policy.version}`;
  if (state.policyDirty && !force) return;
  $('#policy-text').value = JSON.stringify(state.policy, null, 2);
  state.policyDirty = false;
}

async function savePolicy() {
  const status = $('#policy-status');
  let parsed;
  try {
    parsed = JSON.parse($('#policy-text').value);
  } catch (e) {
    status.className = 'policy-status bad';
    status.textContent = `JSON inválido: ${e.message}`;
    return;
  }
  if (!actor()) {
    toast('Indica en "Actuando como" quién cambia la política', 'bad');
    return;
  }
  try {
    const res = await api('PUT', '/api/policy', { policy: parsed, actor: actor() });
    state.policy = res.policy;
    state.policyDirty = false;
    renderPolicyEditor(true);
    status.className = 'policy-status ok';
    status.textContent = `Guardada como v${res.policy.version} por ${actor()}. Se aplica a las siguientes decisiones (y al aprobar pendientes).`;
    toast(`Política v${res.policy.version} guardada`, 'ok');
    await refreshAll();
  } catch (e) {
    status.className = 'policy-status bad';
    status.innerHTML = e.issues
      ? `No se guardó:<br>${e.issues.map((i) => `· ${esc((i.path ?? []).join('.') || '(raíz)')}: ${esc(i.message)}`).join('<br>')}`
      : `No se guardó: ${esc(e.message)}`;
  }
}

// ---------------------------------------------------------------- global audit

function renderAudit() {
  const events = state.audit.slice(-40).reverse();
  const sig = events.map((e) => e.id).join(',');
  if (sig === state.auditSig) return;
  state.auditSig = sig;
  $('#audit-list').innerHTML =
    events.length === 0
      ? '<div class="empty">Sin eventos todavía.</div>'
      : events
          .map((e) => {
            const [label] = EVENT[e.type] ?? [e.type];
            const summary = eventSummary(e);
            return `<div class="audit-row"><div class="muted num small">${fmtTime(e.at)}</div>
              <div><strong>${esc(label)}</strong> <span class="muted small">· ${esc(e.actor)}</span>
              ${e.requestId ? ` <a class="mono" href="#/requests/${esc(e.requestId)}">${esc(e.requestId)}</a>` : ''}
              ${summary ? `<div class="small muted">${esc(summary)}</div>` : ''}</div></div>`;
          })
          .join('');
}

// ---------------------------------------------------------------- polling

async function refreshAll() {
  const [health, budgets, requests, audit] = await Promise.all([
    api('GET', '/api/health'),
    api('GET', '/api/budgets'),
    api('GET', '/api/requests'),
    api('GET', '/api/audit'),
  ]);
  const policyChanged = !state.policy || state.policy.version !== health.policyVersion;
  state.health = health;
  state.budgets = budgets.budgets;
  state.requests = requests.requests;
  state.audit = audit.audit;
  if (policyChanged) {
    state.policy = (await api('GET', '/api/policy')).policy;
    renderSessionOptions();
    renderPolicyEditor();
  }
  renderChips();
  renderBudgets();
  renderRequests();
  renderAudit();
}

let polling = false;
async function tick() {
  if (polling) return;
  polling = true;
  try {
    await refreshAll();
    if (state.selectedId) await loadSelected();
  } catch (e) {
    console.warn('poll failed', e);
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------- wiring

function wire() {
  const actorEl = $('#actor');
  actorEl.value = store.get('sg.actor', 'ana@acme.test');
  actorEl.addEventListener('change', () => {
    store.set('sg.actor', actor());
    renderChatContext();
    renderDetail(true);
  });
  actorEl.addEventListener('input', () => renderChatContext());
  $('#department').addEventListener('change', () => {
    store.set('sg.department', department());
    state.budgetSig = '';
    renderBudgets();
    renderChatContext();
  });

  $('#filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    state.listSig = '';
    renderRequests();
  });
  $('#requests-body').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-id]');
    if (row) select(row.dataset.id);
  });
  $('#detail').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'close') return select(null);
    btn.disabled = true;
    runAction(btn.dataset.action).finally(() => {
      btn.disabled = false;
    });
  });

  const input = $('#chat-input');
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = '';
    sendChat(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#chat-form').requestSubmit();
    }
  });
  $('#suggestions').addEventListener('click', (e) => {
    const s = e.target.closest('[data-suggest]');
    if (s) sendChat(s.dataset.suggest);
  });
  $('#chat-reset').addEventListener('click', () => {
    state.chat = { messages: [], history: [] };
    session.set('sg.chat', state.chat);
    renderChat();
  });

  $('#policy-text').addEventListener('input', () => {
    state.policyDirty = true;
    $('#policy-status').textContent = 'Cambios sin guardar';
    $('#policy-status').className = 'policy-status';
  });
  $('#policy-save').addEventListener('click', savePolicy);
  $('#policy-reload').addEventListener('click', async () => {
    try {
      state.policy = (await api('GET', '/api/policy')).policy;
      state.policyDirty = false;
      renderPolicyEditor(true);
      $('#policy-status').textContent = '';
    } catch (e) {
      toast(e.message, 'bad');
    }
  });

  window.addEventListener('hashchange', routeFromHash);
}

async function init() {
  const saved = session.get('sg.chat');
  if (saved && Array.isArray(saved.messages)) state.chat = { messages: saved.messages, history: saved.history ?? [] };
  wire();
  renderPlaceholder();
  state.detailSig = 'none';
  renderChat();
  try {
    await refreshAll();
  } catch (e) {
    toast(`No pude conectar con SpendGuard: ${e.message}`, 'bad');
  }
  routeFromHash();
  setInterval(tick, POLL_MS);
}

init();
