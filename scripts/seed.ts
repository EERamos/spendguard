/**
 * Fills a running SpendGuard with a mix of demo scenarios through its HTTP API.
 *   npm run dev          (in one terminal)
 *   npm run seed         (in another; BASE_URL defaults to http://localhost:3000)
 * Requests carry a clientRef, so running it twice does not duplicate them.
 */

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

interface Req {
  id: string;
  status: string;
  item: { productName: string; quantity: number };
  quote: { total: { amount: number; currency: string } };
  checkout?: { id: string; paymentUrl?: string };
  decision: { hits: { message: string; outcome: string }[] };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } } & T;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error?.code ?? ''}: ${data.error?.message ?? ''}`);
  return data;
}

const line = (r: Req, note = '') =>
  console.log(
    `  ${r.status.padEnd(17)} ${r.item.productName.slice(0, 48).padEnd(48)} x${r.item.quantity}  ${r.quote.total.amount.toFixed(2)} ${r.quote.total.currency}${note ? `  · ${note}` : ''}`,
  );

async function propose(body: Record<string, unknown>): Promise<Req> {
  const { request } = await call<{ request: Req }>('POST', '/api/requests', body);
  return request;
}

/** Simulates the card holder on the mock Reap page, then polls until the order is reconciled. */
async function pay(r: Req, finalAmount?: number): Promise<Req> {
  if (r.status !== 'AWAITING_PAYMENT' || !r.checkout?.paymentUrl) return r;
  const path = new URL(r.checkout.paymentUrl).pathname;
  const form = new URLSearchParams({ action: 'approve', ...(finalAmount !== undefined ? { finalAmount: finalAmount.toFixed(2) } : {}) });
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
  if (res.status !== 302) throw new Error(`Pago simulado falló (${res.status})`);
  let current = r;
  for (let i = 0; i < 4 && current.status === 'AWAITING_PAYMENT'; i++) {
    current = (await call<{ request: Req }>('POST', `/api/requests/${r.id}/refresh`)).request;
  }
  return current;
}

async function main(): Promise<void> {
  let health: { reapMode: string; agentMode: string; policyVersion: number };
  try {
    health = await call('GET', '/api/health');
  } catch (e) {
    console.error(`No pude conectar con SpendGuard en ${BASE_URL}. Inícialo con "npm run dev". (${e instanceof Error ? e.message : e})`);
    process.exit(1);
  }
  const mock = health.reapMode === 'mock';
  console.log(`SpendGuard en ${BASE_URL} · Reap ${health.reapMode} · agente ${health.agentMode} · política v${health.policyVersion}\n`);
  if (!mock) console.log('Reap en modo live: no simulo pagos; los checkouts quedan esperando al titular de la tarjeta.\n');

  console.log('Ingeniería (autoaprueba ≤ 150, aprueba cto@acme.test)');
  const switches = await propose({
    clientRef: 'seed-switches',
    requesterEmail: 'ana@acme.test',
    departmentId: 'eng',
    productId: 'p_switches',
    quantity: 2,
    justification: 'Switches de repuesto para los teclados del equipo de plataforma',
  });
  line(mock ? await pay(switches) : switches, 'autoaprobada y pagada');

  const monitor = await propose({
    clientRef: 'seed-monitor',
    requesterEmail: 'ana@acme.test',
    departmentId: 'eng',
    productId: 'p_monitor',
    quantity: 1,
    justification: 'Segundo monitor portátil para guardias on-call desde casa',
  });
  line(monitor, 'espera a cto@acme.test');

  let dock = await propose({
    clientRef: 'seed-dock',
    requesterEmail: 'ana@acme.test',
    departmentId: 'eng',
    productId: 'p_dock',
    quantity: 1,
    justification: 'Docking station para la nueva laptop del equipo de datos',
  });
  if (dock.status === 'PENDING_APPROVAL') {
    dock = (await call<{ request: Req }>('POST', `/api/requests/${dock.id}/approve`, { actor: 'cto@acme.test', note: 'Aprobado, es equipo base' })).request;
  }
  // The final charge comes back higher than the quote, so reconciliation flags it.
  line(mock ? await pay(dock, dock.quote.total.amount + 7.5) : dock, mock ? 'aprobada, cargo final distinto (conciliación marcada)' : 'aprobada');

  console.log('\nMarketing (autoaprueba ≤ 100, aprueba cmo@acme.test)');
  const headphones = await propose({
    clientRef: 'seed-headphones',
    requesterEmail: 'luis@acme.test',
    departmentId: 'marketing',
    productId: 'p_headphones',
    quantity: 1,
    justification: 'Audífonos para editar los videos del lanzamiento',
  });
  if (headphones.status === 'PENDING_APPROVAL') {
    await call('POST', `/api/requests/${headphones.id}/reject`, {
      actor: 'cmo@acme.test',
      reason: 'Usemos los audífonos del estudio; este trimestre no hay presupuesto para audio',
    });
  }
  line({ ...headphones, status: headphones.status === 'PENDING_APPROVAL' ? 'REJECTED' : headphones.status }, 'rechazada por cmo@acme.test');

  const giftcard = await propose({
    clientRef: 'seed-giftcard',
    requesterEmail: 'luis@acme.test',
    departmentId: 'marketing',
    productId: 'p_giftcard',
    quantity: 1,
    justification: 'Premio para el concurso de redes sociales',
  });
  line(giftcard, 'categoría y merchant bloqueados');

  console.log('\nOperaciones (autoaprueba ≤ 75, tope 500, aprueba coo@acme.test)');
  const coffee = await propose({
    clientRef: 'seed-coffee',
    requesterEmail: 'sofia@acme.test',
    departmentId: 'ops',
    productId: 'p_coffee',
    optionIds: ['opt_coffee_beans'],
    quantity: 1,
    justification: 'Café en grano para la oficina',
  });
  line(coffee, 'autoaprobada: abre el link de pago en el dashboard');

  const planter = await propose({
    clientRef: 'seed-planter',
    requesterEmail: 'sofia@acme.test',
    departmentId: 'ops',
    productId: 'p_planter',
    quantity: 1,
    justification: 'Decoración para la recepción',
  });
  line(planter, 'merchant bloqueado');

  const optiplex = await propose({
    clientRef: 'seed-optiplex',
    requesterEmail: 'sofia@acme.test',
    departmentId: 'ops',
    productId: 'p_optiplex',
    quantity: 1,
    justification: 'Computadora para el punto de venta de la bodega',
  });
  line(optiplex, 'excede el tope por compra');

  console.log('\nAgente');
  const chat = await call<{ reply: string; requests: Req[]; mode: string }>('POST', '/api/agent/chat', {
    message: 'Compra 2 power banks de menos de 100 dólares para el equipo de soporte',
    requesterEmail: 'ana@acme.test',
    departmentId: 'eng',
  });
  for (const r of chat.requests) line(r, `vía agente (${chat.mode})`);
  console.log(`  "${chat.reply.split('\n')[0]}"`);

  const { budgets } = await call<{ budgets: { name: string; committed: number; reserved: number; remaining: number; currency: string }[] }>('GET', '/api/budgets');
  console.log('\nPresupuestos');
  for (const b of budgets) {
    console.log(`  ${b.name.padEnd(12)} gastado ${b.committed.toFixed(2).padStart(8)}  reservado ${b.reserved.toFixed(2).padStart(8)}  disponible ${b.remaining.toFixed(2).padStart(8)} ${b.currency}`);
  }
  console.log(`\nListo. Abre ${BASE_URL} para ver el dashboard.`);
}

main().catch((e: unknown) => {
  console.error('Seed falló:', e instanceof Error ? e.message : e);
  process.exit(1);
});
