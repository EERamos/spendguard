import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { createAgent } from './agent';
import type { Agent } from './agent/types';
import { loadConfig } from './config';
import type { AppConfig } from './config';
import { PolicyProvider } from './domain/policy';
import type { Policy } from './domain/policy';
import type { RequestStatus } from './domain/types';
import { createReapClient, MockReapClient } from './reap';
import { ReapApiError } from './reap/errors';
import type { ReapClient } from './reap/types';
import { PurchaseService } from './services/purchase-service';
import { JsonStore } from './store/store';
import type { Store } from './store/store';
import { DomainError } from './util/errors';

export interface AppOverrides {
  /** When given, merged over the built-in defaults (the environment and .env are NOT read). */
  config?: Partial<AppConfig>;
  reap?: ReapClient;
  agent?: Agent | ((service: PurchaseService) => Agent);
  now?: () => number;
  policy?: PolicyProvider | Policy;
  store?: Store;
}

export interface BuiltApp {
  app: FastifyInstance;
  service: PurchaseService;
  store: Store;
  reap: ReapClient;
  policy: PolicyProvider;
  agent: Agent;
  config: AppConfig;
}

const STATUSES = [
  'DENIED',
  'PENDING_APPROVAL',
  'REJECTED',
  'AWAITING_PAYMENT',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
] as const satisfies readonly RequestStatus[];

const Email = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Email inválido');

const ShippingAddressSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().min(5),
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().length(2),
});

const CreateRequestBody = z.object({
  requesterEmail: Email,
  requesterId: z.string().min(1).optional(),
  departmentId: z.string().min(1),
  justification: z.string().default(''),
  productId: z.string().min(1),
  optionIds: z.array(z.string().min(1)).optional(),
  quantity: z.coerce.number().int().min(1),
  declaredMaxTotal: z.coerce.number().positive().optional(),
  shippingAddress: ShippingAddressSchema.optional(),
  shippingOptionId: z.string().min(1).optional(),
  offerCode: z.string().min(1).optional(),
  searchText: z.string().optional(),
  clientRef: z.string().min(1).max(200).optional(),
});

const ActorBody = z.object({ actor: Email.optional() }).passthrough();
const ApproveBody = z.object({ actor: Email.optional(), note: z.string().max(1000).optional() });
const RejectBody = z.object({ actor: Email.optional(), reason: z.string().trim().min(1, 'Indica el motivo del rechazo').max(1000) });

const ChatBody = z.object({
  message: z.string().trim().min(1).max(4000),
  requesterEmail: Email,
  requesterId: z.string().min(1).optional(),
  departmentId: z.string().min(1),
  history: z.array(z.unknown()).max(200).optional(),
  shippingAddress: ShippingAddressSchema.optional(),
});

const ListQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(STATUSES)).optional()),
  departmentId: z.string().min(1).optional(),
});

const SearchQuery = z.object({
  q: z.string().trim().min(1, 'Falta el parámetro q'),
  maxPrice: z.coerce.number().positive().optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
  merchant: z.string().min(1).optional(),
});

const IdParams = z.object({ id: z.string().min(1) });
const CheckoutParams = z.object({ checkoutId: z.string().min(1) });
const MockActionBody = z.object({
  action: z.enum(['approve', 'fail']),
  finalAmount: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
    .pipe(z.number().positive().optional()),
});

const WEB_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};
const WEB_DIR = new URL('../web/', import.meta.url);

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function actorOf(req: FastifyRequest, bodyActor?: string): string {
  const header = req.headers['x-actor-email'];
  const actor = (bodyActor ?? (Array.isArray(header) ? header[0] : header) ?? '').trim().toLowerCase();
  if (!actor) throw new DomainError('ACTOR_REQUIRED', 'Falta el email de quien actúa (campo actor o header x-actor-email)', 400);
  return actor;
}

export async function buildApp(overrides: AppOverrides = {}): Promise<BuiltApp> {
  const config: AppConfig = overrides.config ? { ...loadConfig({}), ...overrides.config } : loadConfig();

  const policy =
    overrides.policy instanceof PolicyProvider
      ? overrides.policy
      : overrides.policy
        ? new PolicyProvider(null, overrides.policy)
        : new PolicyProvider(config.policyFile);

  const store = overrides.store ?? new JsonStore(config.dataFile);
  const reap =
    overrides.reap ??
    (config.reapMode === 'mock' && overrides.now
      ? new MockReapClient({ publicBaseUrl: config.publicBaseUrl, now: overrides.now })
      : createReapClient(config));

  const service = new PurchaseService({
    store,
    reap,
    policy,
    publicBaseUrl: config.publicBaseUrl,
    defaultShipping: config.defaultShipping,
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  const agent =
    typeof overrides.agent === 'function' ? overrides.agent(service) : (overrides.agent ?? createAgent(config, service));

  const app = Fastify({ logger: config.logger, disableRequestLogging: true });

  // The dashboard polls every few seconds: log only writes and failures.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' || reply.statusCode >= 400) {
      req.log.info({ method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
    }
  });

  // The mock payment page posts a classic HTML form.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}) } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '),
          issues: err.issues,
        },
      });
    }
    if (err instanceof ReapApiError) {
      req.log.warn({ code: err.code, status: err.status }, 'Reap API error');
      return reply.status(502).send({
        error: { code: `REAP_${err.code}`, message: err.message, reapStatus: err.status, ...(err.detail !== undefined ? { detail: err.detail } : {}) },
      });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message ?? 'Solicitud inválida' } });
    }
    req.log.error({ err }, 'Unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Error interno del servidor' } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Ruta no encontrada: ${req.method} ${req.url.split('?')[0]}` } });
  });

  // ------------------------------------------------------------------ API

  app.get('/api/health', async () => ({
    ok: true,
    reapMode: reap instanceof MockReapClient ? 'mock' : 'live',
    agentMode: agent.mode,
    policyVersion: policy.get().version,
  }));

  app.get('/api/policy', async () => ({ policy: service.getPolicy() }));

  app.put('/api/policy', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const wrapped = body && typeof body === 'object' && 'policy' in body && typeof body.policy === 'object';
    const next = wrapped ? body.policy : body;
    const actor = actorOf(req, typeof body.actor === 'string' ? body.actor : undefined);
    if (!wrapped && next && typeof next === 'object') delete (next as Record<string, unknown>).actor;
    return { policy: service.updatePolicy(next, actor) };
  });

  app.get('/api/budgets', async () => {
    const budgets = service.budgets();
    return { month: budgets[0]?.month ?? new Date().toISOString().slice(0, 7), budgets };
  });

  app.get('/api/requests', async (req) => {
    const q = ListQuery.parse(req.query);
    return {
      requests: service.list({
        ...(q.status ? { status: q.status } : {}),
        ...(q.departmentId ? { departmentId: q.departmentId } : {}),
      }),
    };
  });

  app.get('/api/requests/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return { request: service.get(id), audit: service.audit(id) };
  });

  app.get('/api/audit', async (req) => {
    const { requestId } = z.object({ requestId: z.string().min(1).optional() }).parse(req.query);
    return { audit: service.audit(requestId) };
  });

  app.post('/api/requests', async (req, reply) => {
    const b = CreateRequestBody.parse(req.body ?? {});
    const request = await service.propose({
      requester: { id: b.requesterId ?? b.requesterEmail, email: b.requesterEmail },
      departmentId: b.departmentId,
      justification: b.justification,
      productId: b.productId,
      quantity: b.quantity,
      ...(b.optionIds ? { optionIds: b.optionIds } : {}),
      ...(b.declaredMaxTotal !== undefined ? { declaredMaxTotal: b.declaredMaxTotal } : {}),
      ...(b.shippingAddress ? { shippingAddress: b.shippingAddress } : {}),
      ...(b.shippingOptionId ? { shippingOptionId: b.shippingOptionId } : {}),
      ...(b.offerCode ? { offerCode: b.offerCode } : {}),
      ...(b.searchText ? { searchText: b.searchText } : {}),
      ...(b.clientRef ? { clientRef: b.clientRef } : {}),
    });
    return reply.status(201).send({ request });
  });

  app.post('/api/requests/:id/approve', async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = ApproveBody.parse(req.body ?? {});
    return { request: await service.approve(id, actorOf(req, b.actor), b.note?.trim() || undefined) };
  });

  app.post('/api/requests/:id/reject', async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = RejectBody.parse(req.body ?? {});
    return { request: await service.reject(id, actorOf(req, b.actor), b.reason) };
  });

  app.post('/api/requests/:id/cancel', async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = ActorBody.parse(req.body ?? {});
    return { request: await service.cancel(id, actorOf(req, b.actor)) };
  });

  app.post('/api/requests/:id/refresh', async (req) => {
    const { id } = IdParams.parse(req.params);
    return { request: await service.refresh(id) };
  });

  app.post('/api/agent/chat', async (req) => {
    const b = ChatBody.parse(req.body ?? {});
    const result = await agent.chat({
      message: b.message,
      requester: { id: b.requesterId ?? b.requesterEmail, email: b.requesterEmail },
      departmentId: b.departmentId,
      ...(b.history ? { history: b.history } : {}),
      ...(b.shippingAddress ? { shippingAddress: b.shippingAddress } : {}),
    });
    const requests = result.requestIds.flatMap((id) => {
      try {
        return [service.get(id)];
      } catch {
        return [];
      }
    });
    return { ...result, requests };
  });

  app.get('/api/products/search', async (req) => {
    const q = SearchQuery.parse(req.query);
    return service.searchProducts(q.q, {
      ...(q.maxPrice !== undefined ? { maxPrice: q.maxPrice } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.merchant ? { merchant: q.merchant } : {}),
    });
  });

  app.get('/api/products/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return { product: await service.getProduct(id) };
  });

  // Reap sends the card holder back here. Returning does NOT mean the order exists: we ask Reap.
  app.get('/return/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    try {
      await service.refresh(id);
    } catch (e) {
      req.log.warn({ requestId: id, err: e instanceof Error ? e.message : String(e) }, 'refresh on return failed');
    }
    return reply.redirect(`/#/requests/${encodeURIComponent(id)}`, 302);
  });

  // ------------------------------------------------------------------ mock Reap hosted page

  if (reap instanceof MockReapClient) {
    const mock = reap;

    app.get('/mock/reap/approve/:checkoutId', async (req, reply) => {
      const { checkoutId } = CheckoutParams.parse(req.params);
      let html: string;
      try {
        html = mockApprovalPage(mock.describeCheckout(checkoutId));
      } catch (e) {
        html = mockMessagePage('Checkout no encontrado', e instanceof Error ? e.message : String(e));
        reply.status(404);
      }
      return reply.type('text/html; charset=utf-8').send(html);
    });

    app.post('/mock/reap/approve/:checkoutId', async (req, reply) => {
      const { checkoutId } = CheckoutParams.parse(req.params);
      const b = MockActionBody.parse(req.body ?? {});
      try {
        const { returnUrl } =
          b.action === 'approve'
            ? mock.approveCheckout(checkoutId, b.finalAmount !== undefined ? { finalAmount: b.finalAmount } : {})
            : mock.failCheckout(checkoutId);
        return reply.redirect(returnUrl, 302);
      } catch (e) {
        let back = '/';
        try {
          back = mock.describeCheckout(checkoutId).returnUrl;
        } catch {
          // unknown checkout: go to the dashboard
        }
        return reply
          .status(409)
          .type('text/html; charset=utf-8')
          .send(mockMessagePage('No se pudo procesar el pago', e instanceof Error ? e.message : String(e), back));
      }
    });
  }

  // ------------------------------------------------------------------ dashboard

  const serveWeb = async (req: FastifyRequest, reply: FastifyReply) => {
    const entry = WEB_FILES[req.url.split('?')[0]!];
    if (!entry) return reply.callNotFound();
    const body = await readFile(new URL(entry.file, WEB_DIR), 'utf8');
    return reply.type(entry.type).header('cache-control', 'no-cache').send(body);
  };
  for (const path of Object.keys(WEB_FILES)) app.get(path, serveWeb);

  return { app, service, store, reap, policy, agent, config };
}

// ------------------------------------------------------------------ mock page templates

type CheckoutDescription = ReturnType<MockReapClient['describeCheckout']>;

const PAGE_STYLE = `
  :root { --bg:#f4f5f7; --card:#fff; --ink:#14161a; --muted:#5b6170; --line:#e3e5ea; --brand:#4b3cf0; --danger:#c62f3a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#181b21; --ink:#eceef2; --muted:#9aa1ae; --line:#2a2e37; --brand:#8b80ff; --danger:#ff6b76; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--ink); }
  .banner { background:#ffd84d; color:#2b2400; text-align:center; padding:8px 16px; font-weight:600; font-size:13px; }
  main { max-width:520px; margin:32px auto; padding:0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; } .muted { color:var(--muted); font-size:13px; }
  table { width:100%; border-collapse:collapse; margin:16px 0; font-size:14px; }
  td { padding:8px 0; border-bottom:1px solid var(--line); } td.r { text-align:right; font-variant-numeric:tabular-nums; }
  .total { font-size:22px; font-weight:700; text-align:right; margin:8px 0 16px; font-variant-numeric:tabular-nums; }
  .note { background:var(--bg); border-radius:10px; padding:12px; font-size:13px; color:var(--muted); margin:16px 0; }
  .actions { display:flex; gap:12px; flex-wrap:wrap; }
  button, a.btn { flex:1; min-width:140px; border:0; border-radius:10px; padding:12px 16px; font:inherit; font-weight:600; cursor:pointer; text-align:center; text-decoration:none; }
  .ok { background:var(--brand); color:#fff; } .ko { background:transparent; color:var(--danger); border:1px solid var(--danger); }
  details { margin-top:16px; font-size:13px; color:var(--muted); } input { font:inherit; padding:6px 8px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); width:120px; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body>
<div class="banner">Simulación de la página de Reap (modo mock)</div><main>${body}</main></body></html>`;
}

function mockApprovalPage(c: CheckoutDescription): string {
  const lines = c.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.name)}<div class="muted">${esc(l.merchant)} · ${l.quantity} × ${l.unit.toFixed(2)} ${esc(c.amount.currency)}</div></td>` +
        `<td class="r">${(l.unit * l.quantity).toFixed(2)}</td></tr>`,
    )
    .join('');
  const total = `${c.amount.amount.toFixed(2)} ${esc(c.amount.currency)}`;
  const open = c.status === 'REQUIRES_ACTION';
  const actions = open
    ? `<form method="post" action="/mock/reap/approve/${encodeURIComponent(c.id)}">
        <div class="actions">
          <button class="ok" name="action" value="approve">Aprobar pago</button>
          <button class="ko" name="action" value="fail">Rechazar</button>
        </div>
        <details><summary>Opciones de simulación</summary>
          <p>Cargo final distinto (para probar la conciliación): <input name="finalAmount" inputmode="decimal" placeholder="${c.amount.amount.toFixed(2)}"></p>
        </details>
      </form>`
    : `<p>Este checkout ya está en estado <strong>${esc(c.status)}</strong>.</p><div class="actions"><a class="btn ok" href="${esc(c.returnUrl)}">Volver a SpendGuard</a></div>`;

  return shell(
    'Reap · Aprobar pago (mock)',
    `<div class="card">
      <h1>Revisa y aprueba el pago</h1>
      <div class="muted">Checkout ${esc(c.id)} · estado ${esc(c.status)}</div>
      <table>${lines}</table>
      <div class="muted" style="text-align:right">Total con envío e impuestos</div>
      <div class="total">${total}</div>
      <div class="note">En el sandbox real de Reap, aquí el titular elige o captura la tarjeta del equipo y confirma con el OTP <strong>456789</strong>.
      SpendGuard y el agente nunca ven los datos de la tarjeta.</div>
      ${actions}
    </div>`,
  );
}

function mockMessagePage(title: string, message: string, back = '/'): string {
  return shell(
    title,
    `<div class="card"><h1>${esc(title)}</h1><p class="muted">${esc(message)}</p>
     <div class="actions"><a class="btn ok" href="${esc(back)}">Volver a SpendGuard</a></div></div>`,
  );
}
