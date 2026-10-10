/**
 * End-to-end smoke test, fully in-process: mock Reap, in-memory store, no agent connected, no network.
 * Run with `npm run smoke`. Exits 1 on the first failure.
 */
import { NOT_CONFIGURED_REPLY } from '../src/agent';
import { buildApp } from '../src/app';
import type { PurchaseRequest } from '../src/domain/types';

let failures = 0;

function check(cond: unknown, label: string, detail?: unknown): void {
  if (cond) {
    console.log(`✔ ${label}`);
  } else {
    failures += 1;
    console.error(`✘ ${label}`);
    if (detail !== undefined) console.error('  ', typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
    throw new Error(label);
  }
}

async function main(): Promise<void> {
  const { app } = await buildApp({
    config: { dataFile: null, logger: false, reapMode: 'mock' },
  });

  const json = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => {
    const res = await app.inject({ method, url, ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}) });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {}, headers: res.headers };
  };
  const propose = (body: Record<string, unknown>) =>
    json('POST', '/api/requests', {
      requesterEmail: 'ana@acme.test',
      departmentId: 'eng',
      justification: 'Material para el equipo de plataforma en el sprint de pagos',
      quantity: 1,
      ...body,
    });

  // 1. Health
  const health = await json('GET', '/api/health');
  check(health.status === 200 && health.body.ok === true && health.body.reapMode === 'mock' && health.body.agentMode === 'none', 'health: ok, Reap mock, agente no conectado', health.body);

  // 2. Auto-approve: cheap switches -> checkout opened, payment link exists
  const auto = await propose({ productId: 'p_switches', quantity: 2 });
  const autoReq = auto.body.request as PurchaseRequest;
  check(auto.status === 201 && autoReq.status === 'AWAITING_PAYMENT', `autoaprobación: ${autoReq?.quote.total.amount} USD -> AWAITING_PAYMENT`, auto.body);
  check(!!autoReq.checkout?.paymentUrl, 'autoaprobación: hay link de pago de Reap', autoReq.checkout);

  // 3. Card holder pays on the (mock) Reap page, then SpendGuard reconciles
  const page = await app.inject({ method: 'GET', url: new URL(autoReq.checkout!.paymentUrl!).pathname });
  check(page.statusCode === 200 && page.body.includes('Simulación de la página de Reap'), 'página mock de Reap se muestra');
  const paid = await app.inject({
    method: 'POST',
    url: `/mock/reap/approve/${autoReq.checkout!.id}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'action=approve',
  });
  check(paid.statusCode === 302 && String(paid.headers.location).includes(`/return/${autoReq.id}`), 'pago simulado redirige al returnUrl', paid.headers);
  const ret = await app.inject({ method: 'GET', url: `/return/${autoReq.id}` });
  check(ret.statusCode === 302 && ret.headers.location === `/#/requests/${autoReq.id}`, 'returnUrl redirige al dashboard');
  await json('POST', `/api/requests/${autoReq.id}/refresh`);
  const done = await json('POST', `/api/requests/${autoReq.id}/refresh`);
  const doneReq = done.body.request as PurchaseRequest;
  check(doneReq.status === 'COMPLETED' && !!doneReq.checkout?.orderId, `pago confirmado: COMPLETED (orden ${doneReq.checkout?.orderId})`, doneReq);
  check(doneReq.reconciliation && doneReq.reconciliation.flagged === false, 'conciliación sin variación', doneReq.reconciliation);

  // 4. Needs approval: monitor above the eng auto-approve limit
  const pending = await propose({ productId: 'p_monitor' });
  const pendingReq = pending.body.request as PurchaseRequest;
  check(pendingReq.status === 'PENDING_APPROVAL' && !pendingReq.checkout, `requiere aprobación: ${pendingReq.quote.total.amount} USD > 150, sin link de pago`, pending.body);
  const notApprover = await json('POST', `/api/requests/${pendingReq.id}/approve`, { actor: 'ana@acme.test' });
  check(notApprover.status === 403 && notApprover.body.error.code === 'NOT_AN_APPROVER', 'quien no es aprobador recibe 403', notApprover.body);
  const approved = await json('POST', `/api/requests/${pendingReq.id}/approve`, { actor: 'cto@acme.test', note: 'OK para trabajo remoto' });
  check(approved.status === 200 && approved.body.request.status === 'AWAITING_PAYMENT' && approved.body.request.checkout?.paymentUrl, 'cto@acme.test aprueba -> AWAITING_PAYMENT con link', approved.body);

  // 5. Separation of duties: an approver cannot approve their own request
  const own = await json('POST', '/api/requests', {
    requesterEmail: 'cto@acme.test',
    departmentId: 'eng',
    justification: 'Monitor para revisar dashboards de pagos',
    productId: 'p_monitor',
    quantity: 1,
  });
  const selfApprove = await json('POST', `/api/requests/${own.body.request.id}/approve`, { actor: 'cto@acme.test' });
  check(selfApprove.status === 403 && selfApprove.body.error.code === 'SELF_APPROVAL_FORBIDDEN', 'autoaprobación de la propia solicitud: 403', selfApprove.body);

  // 6. Blocked merchant
  const denied = await propose({ productId: 'p_planter' });
  const deniedReq = denied.body.request as PurchaseRequest;
  check(
    deniedReq.status === 'DENIED' && deniedReq.decision.hits.some((h) => h.rule === 'MERCHANT_BLOCKED') && !deniedReq.checkout,
    'merchant bloqueado (liquiddeath.com) -> DENIED sin checkout',
    deniedReq?.decision,
  );

  // 7. Validation and error mapping
  const invalid = await json('POST', '/api/requests', { departmentId: 'eng', productId: 'p_switches', quantity: 0 });
  check(invalid.status === 400 && invalid.body.error.code === 'VALIDATION_ERROR', 'body inválido -> 400 VALIDATION_ERROR', invalid.body);
  const missing = await json('GET', '/api/requests/req_nope');
  check(missing.status === 404 && missing.body.error.code === 'REQUEST_NOT_FOUND', 'solicitud inexistente -> 404', missing.body);

  // 8. Agent slot: no agent connected yet, the endpoint answers with the placeholder
  const chat = await json('POST', '/api/agent/chat', {
    message: 'compra 2 power banks de menos de 100 dólares',
    requesterEmail: 'ana@acme.test',
    departmentId: 'eng',
  });
  check(
    chat.status === 200 && chat.body.mode === 'none' && chat.body.reply === NOT_CONFIGURED_REPLY && chat.body.requestIds.length === 0,
    'agente: /api/agent/chat responde el placeholder (mode none)',
    chat.body,
  );
  const badChat = await json('POST', '/api/agent/chat', { message: '', requesterEmail: 'ana@acme.test', departmentId: 'eng' });
  check(badChat.status === 400 && badChat.body.error.code === 'VALIDATION_ERROR', 'agente: mensaje vacío -> 400', badChat.body);

  // 9. Budgets reflect spend
  const budgets = await json('GET', '/api/budgets');
  const eng = (budgets.body.budgets as any[]).find((b) => b.departmentId === 'eng');
  check(Math.abs(eng.committed - doneReq.checkout!.finalAmount!.amount) < 0.001, `presupuesto eng: comprometido ${eng.committed} USD`, eng);
  const expectedReserved = [approved.body.request, own.body.request].reduce((s, r: PurchaseRequest) => s + r.quote.total.amount, 0);
  check(Math.abs(eng.reserved - expectedReserved) < 0.01, `presupuesto eng: reservado ${eng.reserved} USD, disponible ${eng.remaining}`, eng);

  // 10. Policy update and audit trail
  const pol = await json('GET', '/api/policy');
  const next = structuredClone(pol.body.policy);
  next.departments.ops.autoApproveUnder = 80;
  const put = await json('PUT', '/api/policy', { policy: next, actor: 'coo@acme.test' });
  check(put.status === 200 && put.body.policy.version === pol.body.policy.version + 1, `política actualizada a v${put.body.policy?.version}`, put.body);
  const badPut = await json('PUT', '/api/policy', { policy: { version: 1 }, actor: 'coo@acme.test' });
  check(badPut.status === 400 && badPut.body.error.code === 'VALIDATION_ERROR', 'política inválida -> 400', badPut.body);
  const detail = await json('GET', `/api/requests/${doneReq.id}`);
  const types = (detail.body.audit as any[]).map((e) => e.type);
  check(['REQUEST_CREATED', 'POLICY_EVALUATED', 'CHECKOUT_CREATED', 'RECONCILED'].every((t) => types.includes(t)), `auditoría: ${types.join(' → ')}`);

  // 11. Dashboard is served
  const index = await app.inject({ method: 'GET', url: '/' });
  check(index.statusCode === 200 && index.body.includes('SpendGuard'), 'dashboard servido en /');

  await app.close();
}

main()
  .then(() => {
    console.log('\nSmoke OK');
    process.exit(0);
  })
  .catch((e: unknown) => {
    if (failures === 0) console.error('✘ error inesperado:', e);
    console.error('\nSmoke FALLÓ');
    process.exit(1);
  });
