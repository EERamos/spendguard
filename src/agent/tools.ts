import { z } from 'zod';
import type { Policy } from '../domain/policy';
import type { PurchaseRequest, Requester } from '../domain/types';
import type { Money } from '../money';
import { ReapApiError } from '../reap/errors';
import type { ShippingAddress } from '../reap/types';
import type { PurchaseService } from '../services/purchase-service';
import { DomainError } from '../util/errors';

/** Max characters of a tool result sent back to the model. */
export const MAX_TOOL_RESULT_CHARS = 4000;

/** Who the agent acts for. Set by the API session; the model can never change it. */
export interface ToolSession {
  requester: Requester;
  departmentId: string;
  shippingAddress?: ShippingAddress;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** Request ids this call created or inspected. */
  requestIds: string[];
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'search_products',
    description:
      'Search the catalog of Reap-supported merchants. Results that company policy would block (blocked merchants or categories) are listed separately in filteredOut with the reason. Prices are unit prices before shipping and tax.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, e.g. "portable monitor" or "teclado mecánico".' },
        maxPrice: { type: 'number', description: 'Optional max unit price in USD.' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Max results (default 6).' },
        merchant: { type: 'string', description: 'Optional merchant domain to prefer, e.g. "baseus.com".' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product_options',
    description:
      'Get a product\'s details: description, option groups (each value has an optionId) and the default variant. Call it before proposing a product that has options.',
    input_schema: {
      type: 'object',
      properties: { productId: { type: 'string' } },
      required: ['productId'],
    },
  },
  {
    name: 'resolve_variant',
    description: 'Resolve the exact variant (price, availability) for a set of optionIds, one per option group.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        optionIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['productId', 'optionIds'],
    },
  },
  {
    name: 'propose_purchase',
    description:
      'Request a purchase. SpendGuard gets a Reap quote and applies company policy: AUTO_APPROVE (returns a Reap payment link for the card holder), REQUIRE_APPROVAL (an internal approver must approve first) or DENY (with reasons). This is the ONLY way to buy. You never pay and never see card data. The requester and department come from the session.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        optionIds: { type: 'array', items: { type: 'string' }, description: 'Option ids for a non-default variant.' },
        quantity: { type: 'integer', minimum: 1 },
        justification: {
          type: 'string',
          description: 'Business reason in the user\'s words (at least 10 characters; required for larger purchases).',
        },
        declaredMaxTotal: {
          type: 'number',
          description: 'Optional: the total (incl. shipping and tax) the user said they are willing to pay. A quote far above it needs human approval.',
        },
        shippingOptionId: { type: 'string', description: 'Optional shipping option id from a previous quote.' },
        offerCode: { type: 'string', description: 'Optional discount code the user provided.' },
        searchText: { type: 'string', description: 'What the user originally asked for (checked against blocked categories).' },
      },
      required: ['productId', 'quantity', 'justification'],
    },
  },
  {
    name: 'get_budget',
    description: "Get the session department's monthly budget (committed, reserved, remaining), auto-approve limit, per-purchase cap and approvers.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_request_status',
    description: 'Get the current status of a purchase request (refreshes the payment status from Reap).',
    input_schema: {
      type: 'object',
      properties: { requestId: { type: 'string' } },
      required: ['requestId'],
    },
  },
];

const SearchInput = z.object({
  query: z.string().min(1),
  maxPrice: z.number().positive().optional(),
  limit: z.number().int().min(1).max(10).optional(),
  merchant: z.string().min(1).optional(),
});
const ProductInput = z.object({ productId: z.string().min(1) });
const VariantInput = z.object({ productId: z.string().min(1), optionIds: z.array(z.string().min(1)) });
const ProposeToolInput = z.object({
  productId: z.string().min(1),
  optionIds: z.array(z.string().min(1)).optional(),
  quantity: z.number().int().min(1),
  justification: z.string(),
  declaredMaxTotal: z.number().positive().optional(),
  shippingOptionId: z.string().min(1).optional(),
  offerCode: z.string().min(1).optional(),
  searchText: z.string().optional(),
});
const StatusInput = z.object({ requestId: z.string().min(1) });

export const STATUS_LABELS: Record<PurchaseRequest['status'], string> = {
  DENIED: 'Denegada',
  PENDING_APPROVAL: 'Pendiente de aprobación',
  REJECTED: 'Rechazada',
  AWAITING_PAYMENT: 'Esperando pago en Reap',
  COMPLETED: 'Completada',
  FAILED: 'Fallida',
  EXPIRED: 'Expirada',
  CANCELLED: 'Cancelada',
};

export const money = (m: Money | undefined): string | undefined => (m ? `${m.amount.toFixed(2)} ${m.currency}` : undefined);

/** Compact, model- and human-friendly view of a purchase request. */
export interface RequestView {
  requestId: string;
  status: PurchaseRequest['status'];
  outcome: PurchaseRequest['decision']['outcome'];
  product: string;
  merchant: string;
  quantity: number;
  total: string;
  reasons: string[];
  approvers?: string[];
  paymentUrl?: string;
  orderId?: string;
  nextStep: string;
}

export function describeRequest(r: PurchaseRequest, opts: { approvers?: string[] } = {}): RequestView {
  const approvers = opts.approvers ?? [];
  const who = approvers.length > 0 ? approvers.join(', ') : 'un aprobador del departamento';
  const paymentUrl = r.status === 'AWAITING_PAYMENT' ? r.checkout?.paymentUrl : undefined;

  let nextStep: string;
  switch (r.status) {
    case 'DENIED':
      nextStep = 'La política de la empresa denegó la compra; no se creó ningún link de pago. Revisa los motivos y busca una alternativa permitida.';
      break;
    case 'PENDING_APPROVAL':
      nextStep = `Requiere aprobación interna de ${who} en el dashboard de SpendGuard. El link de pago de Reap se genera solo después de aprobar.`;
      break;
    case 'AWAITING_PAYMENT':
      nextStep =
        'Aprobada. El titular de la tarjeta debe abrir el link de pago de Reap para revisar y autorizar el cargo; SpendGuard nunca ve los datos de la tarjeta.';
      break;
    case 'COMPLETED': {
      const rec = r.reconciliation;
      const recText = rec
        ? rec.flagged
          ? ` Ojo: el cargo final (${rec.finalTotal.toFixed(2)} ${rec.currency}) difiere de lo cotizado (${rec.quotedTotal.toFixed(2)}); quedó marcado para revisión.`
          : ' El cargo final coincide con la cotización.'
        : '';
      nextStep = `Pago confirmado por Reap${r.checkout?.orderId ? ` (orden ${r.checkout.orderId})` : ''}.${recText}`;
      break;
    }
    case 'REJECTED':
      nextStep = `Rechazada por ${r.rejection?.by ?? 'el aprobador'}${r.rejection?.reason ? `: "${r.rejection.reason}"` : ''}.`;
      break;
    case 'FAILED':
      nextStep = `La compra no se pudo completar${r.failure ? `: ${r.failure.message}` : ''}. El presupuesto reservado se liberó.`;
      break;
    case 'EXPIRED':
      nextStep = 'La ventana de pago expiró sin que se autorizara el cargo. Puedes volver a solicitar la compra.';
      break;
    case 'CANCELLED':
      nextStep = 'La solicitud fue cancelada.';
      break;
    default:
      nextStep = '';
  }

  return {
    requestId: r.id,
    status: r.status,
    outcome: r.decision.outcome,
    product: r.item.productName,
    merchant: r.item.merchant,
    quantity: r.item.quantity,
    total: money(r.checkout?.finalAmount ?? r.quote.total) ?? '',
    reasons: r.decision.hits.map((h) => h.message),
    ...(r.status === 'PENDING_APPROVAL' && approvers.length > 0 ? { approvers } : {}),
    ...(paymentUrl ? { paymentUrl } : {}),
    ...(r.checkout?.orderId ? { orderId: r.checkout.orderId } : {}),
    nextStep,
  };
}

export const approversFor = (policy: Policy, departmentId: string): string[] => policy.departments[departmentId]?.approvers ?? [];

/** JSON-serializes and truncates so one tool call can never flood the model context. */
export function serializeResult(value: unknown, max = MAX_TOOL_RESULT_CHARS): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max - 20)}… [truncado]`;
}

export function errorMessage(e: unknown): string {
  if (e instanceof DomainError) return `${e.code}: ${e.message}`;
  if (e instanceof ReapApiError) return `Reap ${e.message}`;
  if (e instanceof z.ZodError) {
    return `Parámetros inválidos: ${e.issues.map((i) => `${i.path.join('.') || '(raíz)'} ${i.message}`).join('; ')}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Executes the agent tools against PurchaseService for one chat session. */
export class AgentToolbox {
  constructor(
    private readonly service: PurchaseService,
    private readonly session: ToolSession,
  ) {}

  async execute(name: string, input: unknown): Promise<ToolOutcome> {
    const requestIds: string[] = [];
    try {
      const value = await this.run(name, input ?? {}, requestIds);
      return { content: serializeResult(value), isError: false, requestIds };
    } catch (e) {
      // Business and Reap errors go back to the model so it can explain or adapt; only bugs would throw.
      return { content: serializeResult({ error: errorMessage(e) }), isError: true, requestIds };
    }
  }

  private async run(name: string, input: unknown, requestIds: string[]): Promise<unknown> {
    switch (name) {
      case 'search_products': {
        const a = SearchInput.parse(input);
        const res = await this.service.searchProducts(a.query, {
          limit: a.limit ?? 6,
          ...(a.maxPrice !== undefined ? { maxPrice: a.maxPrice } : {}),
          ...(a.merchant ? { merchant: a.merchant } : {}),
        });
        return {
          products: res.products.map((p) => ({
            productId: p.productId,
            name: p.name,
            merchant: p.merchant,
            price:
              p.minPrice.amount === p.maxPrice.amount ? money(p.minPrice) : `${money(p.minPrice)} - ${money(p.maxPrice)}`,
            available: p.available,
          })),
          filteredOut: res.filteredOut.map((f) => ({ name: f.name, merchant: f.merchant, reason: f.message })),
          ...(res.warnings.length > 0 ? { warnings: res.warnings } : {}),
        };
      }
      case 'get_product_options': {
        const a = ProductInput.parse(input);
        const p = await this.service.getProduct(a.productId);
        return {
          productId: p.productId,
          name: p.name,
          merchant: p.merchant,
          ...(p.description ? { description: p.description.slice(0, 600) } : {}),
          options: p.options.map((o) => ({
            name: o.name,
            values: o.values.map((v) => ({ optionId: v.optionId, label: v.label, available: v.available !== false })),
          })),
          defaultVariant: {
            variantId: p.defaultVariant.id,
            name: p.defaultVariant.name,
            price: money(p.defaultVariant.price),
            available: p.defaultVariant.available,
            options: p.defaultVariant.options,
          },
        };
      }
      case 'resolve_variant': {
        const a = VariantInput.parse(input);
        const v = await this.service.resolveVariant(a.productId, a.optionIds);
        return { variantId: v.id, name: v.name, price: money(v.price), available: v.available !== false, options: v.options };
      }
      case 'propose_purchase': {
        const a = ProposeToolInput.parse(input);
        const r = await this.service.propose({
          requester: this.session.requester,
          departmentId: this.session.departmentId,
          justification: a.justification,
          productId: a.productId,
          quantity: a.quantity,
          ...(a.optionIds && a.optionIds.length > 0 ? { optionIds: a.optionIds } : {}),
          ...(a.declaredMaxTotal !== undefined ? { declaredMaxTotal: a.declaredMaxTotal } : {}),
          ...(a.shippingOptionId ? { shippingOptionId: a.shippingOptionId } : {}),
          ...(a.offerCode ? { offerCode: a.offerCode } : {}),
          ...(a.searchText ? { searchText: a.searchText } : {}),
          ...(this.session.shippingAddress ? { shippingAddress: this.session.shippingAddress } : {}),
        });
        requestIds.push(r.id);
        return describeRequest(r, { approvers: approversFor(this.service.getPolicy(), r.departmentId) });
      }
      case 'get_budget': {
        const row = this.service.budgets().find((b) => b.departmentId === this.session.departmentId);
        if (!row) throw new DomainError('UNKNOWN_DEPARTMENT', `Departamento desconocido: "${this.session.departmentId}"`, 400);
        return row;
      }
      case 'get_request_status': {
        const a = StatusInput.parse(input);
        const current = this.service.get(a.requestId);
        if (current.requester.email.toLowerCase() !== this.session.requester.email.toLowerCase()) {
          throw new DomainError('FORBIDDEN', 'Solo puedes consultar solicitudes propias', 403);
        }
        const r = await this.service.refresh(a.requestId);
        requestIds.push(r.id);
        return describeRequest(r, { approvers: approversFor(this.service.getPolicy(), r.departmentId) });
      }
      default:
        throw new DomainError('UNKNOWN_TOOL', `Herramienta desconocida: ${name}`, 400);
    }
  }
}
