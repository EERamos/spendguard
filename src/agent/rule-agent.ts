import type { PurchaseRequest } from '../domain/types';
import type { ProductListing, PurchaseService, SearchOutcome } from '../services/purchase-service';
import { STATUS_LABELS, approversFor, describeRequest, errorMessage, money } from './tools';
import type { Agent, AgentInput, AgentResult, TextTurn } from './types';

/**
 * Deterministic agent for demos and tests (no API key needed).
 * It understands one-line purchase requests ("compra 2 power banks de menos de 100 dólares"),
 * status questions ("¿cómo va req_...?") and budget questions, and always goes through PurchaseService.
 */

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

const NUMBER_WORDS: Record<string, number> = {
  dos: 2,
  two: 2,
  tres: 3,
  three: 3,
  cuatro: 4,
  four: 4,
  cinco: 5,
  five: 5,
  seis: 6,
  six: 6,
  siete: 7,
  seven: 7,
  ocho: 8,
  eight: 8,
  nueve: 9,
  nine: 9,
  diez: 10,
  ten: 10,
  doce: 12,
  twelve: 12,
  docena: 12,
  dozen: 12,
  veinte: 20,
  twenty: 20,
};

const PRICE_PATTERNS: RegExp[] = [
  /(?:por menos de|menos de|por debajo de|debajo de|no mas de|maximo de|maximo|max\.?|hasta|under|less than|below|up to|at most|<=?)\s*(?:us)?\$?\s*(\d+(?:[.,]\d{1,2})?)\s*(usd|dolares|dolar|dlls|dls|mxn|pesos|mx)?/,
  /(?:us)?\$\s*(\d+(?:[.,]\d{1,2})?)\s*(usd|mxn)?\s*(?:max|maximo|como maximo|o menos|tope|en total|in total|total)/,
  /\b(\d+(?:[.,]\d{1,2})?)\s*(usd|dolares|dolar|dlls|dls|mxn|pesos)\s*(?:max|maximo|como maximo|o menos|tope|en total|in total|total)/,
];

const UNIT_WORDS = 'mah|w|gb|tb|in|pulgadas|ft|oz|mm|cm|m|kg|g|ml|l|usd|dolares|pesos|mxn|%';

const FILLER = new Set(
  (
    'compra comprar comprame compre compren compras necesito necesitamos ocupo ocupamos quiero queremos pide pideme pidan pedir ' +
    'ordena ordenar ordename consigue consigueme conseguir busca buscame buscar adquiere adquirir hazme haz ' +
    'buy get order purchase need needs want please pls me nos us i we our you can could would puedes podrias puedo ' +
    'por favor porfa hola hey oye ok unos unas algunos algunas some de del la el los las un una uno a an the of x cada each ' +
    'dolares dolar usd pesos mxn dlls dls unidades unidad piezas pieza pzas units unit pcs'
  ).split(' '),
);

export interface ParsedRequest {
  quantity: number;
  /** Max unit price, in the policy base currency. */
  maxPrice?: number;
  /** Set when the user framed the limit as a total ("en total"). */
  declaredMaxTotal?: number;
  query: string;
}

/** Parses quantity, price limit and the product query out of a free-text purchase request. */
export function parsePurchaseMessage(message: string, fx: { mxnToBase?: number } = {}): ParsedRequest {
  let text = normalize(message);

  let limit: number | undefined;
  let isTotal = false;
  for (const re of PRICE_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    let amount = Number(m[1]!.replace(',', '.'));
    const currency = m[2] ?? '';
    if (/mxn|pesos|mx/.test(currency) && fx.mxnToBase) amount = Math.round(amount * fx.mxnToBase * 100) / 100;
    limit = amount;
    isTotal = /\btotal\b/.test(m[0]);
    text = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`;
    break;
  }
  isTotal ||= /\b(en total|total|in total)\b/.test(text);
  text = text.replace(/\b(en total|in total|total)\b/g, ' ');

  let quantity = 1;
  const qtyPatterns: RegExp[] = [
    /\bx\s*(\d{1,3})\b/,
    /\b(\d{1,3})\s*x\b/,
    new RegExp(`(?<![$\\d.,])\\b(\\d{1,3})\\b(?![.,]\\d)(?!\\s*(?:${UNIT_WORDS})\\b)`),
  ];
  for (const re of qtyPatterns) {
    const m = re.exec(text);
    if (m) {
      quantity = Number(m[1]);
      text = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`;
      break;
    }
  }
  if (quantity === 1) {
    const pair = /\b(un par de|a pair of|par de)\b/.exec(text);
    if (pair) {
      quantity = 2;
      text = text.replace(pair[0], ' ');
    } else {
      for (const [word, n] of Object.entries(NUMBER_WORDS)) {
        const re = new RegExp(`\\b${word}\\b`);
        if (re.test(text)) {
          quantity = n;
          text = text.replace(re, ' ');
          break;
        }
      }
    }
  }
  if (quantity < 1) quantity = 1;

  // Drop the purpose clause ("... para el equipo de soporte"): it belongs in the justification, not the search.
  const purpose = /\s(para|for|porque|because|ya que|since)\s/.exec(` ${text} `);
  let product = text;
  if (purpose) {
    const before = ` ${text} `.slice(0, purpose.index);
    if (tokens(before).length > 0) product = before;
  }

  const query = tokens(product).join(' ');
  return {
    quantity,
    ...(limit !== undefined && !isTotal ? { maxPrice: limit } : {}),
    ...(limit !== undefined && isTotal ? { declaredMaxTotal: limit } : {}),
    query,
  };
}

/** Rough ES/EN singular so "monitores", "switches" and "power banks" match catalog wording. */
function singular(word: string): string {
  if (word.length <= 3 || word.endsWith('ss')) return word;
  if (/(ches|shes|xes|zes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.length > 5 && /(ores|ares|ales|eles|iles|ures)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function tokens(text: string): string[] {
  return text
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length >= 2 && !FILLER.has(t) && !/^\d+$/.test(t))
    .map(singular);
}

const REQUEST_ID = /\breq_[a-z0-9]{6,}\b/i;

export class RuleBasedAgent implements Agent {
  readonly mode = 'rules' as const;

  constructor(
    private readonly service: PurchaseService,
    private readonly opts: { maxHistory?: number } = {},
  ) {}

  async chat(input: AgentInput): Promise<AgentResult> {
    const { reply, requestIds } = await this.respond(input);
    const history = this.history(input.history);
    history.push({ role: 'user', content: input.message }, { role: 'assistant', content: reply });
    return { reply, requestIds, history: history.slice(-(this.opts.maxHistory ?? 20)), mode: 'rules' };
  }

  private history(raw: unknown[] | undefined): TextTurn[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (m): m is TextTurn =>
        !!m &&
        typeof m === 'object' &&
        ((m as TextTurn).role === 'user' || (m as TextTurn).role === 'assistant') &&
        typeof (m as TextTurn).content === 'string',
    );
  }

  private async respond(input: AgentInput): Promise<{ reply: string; requestIds: string[] }> {
    const message = input.message.trim();
    const norm = normalize(message);

    const idMatch = REQUEST_ID.exec(message);
    if (idMatch) return this.status(idMatch[0], input);

    if (/\b(presupuesto|budget|cuanto (me )?queda|saldo)\b/.test(norm) && !/\b(compra|comprar|buy|pide|necesito|quiero)\b/.test(norm)) {
      return { reply: this.budgetText(input.departmentId), requestIds: [] };
    }

    const policy = this.service.getPolicy();
    const mxnRate = policy.baseCurrency === 'USD' ? policy.fx['MXN'] : undefined;
    const parsed = parsePurchaseMessage(message, mxnRate ? { mxnToBase: mxnRate } : {});
    if (!parsed.query) {
      return {
        reply:
          'Soy el agente de compras de SpendGuard (modo reglas). Dime qué necesitas, por ejemplo: "compra 2 power banks de menos de 100 dólares". ' +
          'Busco en los comercios de Reap, aplico la política de la empresa y, si procede, te doy el link de pago de Reap. ' +
          'También puedo decirte tu presupuesto o el estado de una solicitud (req_...).',
        requestIds: [],
      };
    }

    let search: SearchOutcome;
    try {
      search = await this.service.searchProducts(parsed.query, {
        limit: 10,
        ...(parsed.maxPrice !== undefined ? { maxPrice: parsed.maxPrice } : {}),
      });
    } catch (e) {
      return { reply: `No pude buscar "${parsed.query}": ${errorMessage(e)}`, requestIds: [] };
    }

    const candidates = search.products
      .filter((p) => p.available && (parsed.maxPrice === undefined || p.minPrice.amount <= parsed.maxPrice))
      .sort((a, b) => a.minPrice.amount - b.minPrice.amount);
    const excluded = this.excludedText(search);

    if (candidates.length === 0) {
      const limitText = parsed.maxPrice !== undefined ? ` por menos de ${parsed.maxPrice.toFixed(2)} ${policy.baseCurrency}` : '';
      const parts = [`No encontré productos permitidos para "${parsed.query}"${limitText}.`];
      if (excluded) parts.push(excluded);
      else parts.push('Prueba con otras palabras o un precio máximo distinto.');
      return { reply: parts.join(' '), requestIds: [] };
    }

    const pick = candidates[0]!;
    let request: PurchaseRequest;
    try {
      request = await this.service.propose({
        requester: input.requester,
        departmentId: input.departmentId,
        justification: message,
        productId: pick.productId,
        quantity: parsed.quantity,
        searchText: message,
        ...(parsed.declaredMaxTotal !== undefined ? { declaredMaxTotal: parsed.declaredMaxTotal } : {}),
        ...(input.shippingAddress ? { shippingAddress: input.shippingAddress } : {}),
      });
    } catch (e) {
      return { reply: `Encontré "${pick.name}" (${pick.merchant}), pero no pude crear la solicitud: ${errorMessage(e)}`, requestIds: [] };
    }

    return { reply: this.outcomeText(request, pick, candidates, excluded), requestIds: [request.id] };
  }

  private outcomeText(r: PurchaseRequest, pick: ProductListing, candidates: ProductListing[], excluded: string): string {
    const view = describeRequest(r, { approvers: approversFor(this.service.getPolicy(), r.departmentId) });
    const blocking = r.decision.hits.filter((h) => h.outcome === r.decision.outcome).map((h) => h.message);
    const lines: string[] = [];

    lines.push(
      `Elegí "${pick.name}" de ${pick.merchant} a ${money(pick.minPrice)} c/u` +
        (candidates.length > 1 ? ` (la opción más barata de ${candidates.length} permitidas).` : '.'),
    );
    lines.push(`Cotización de Reap por ${r.item.quantity} unidad(es): ${view.total} (incluye envío e impuestos). Solicitud ${r.id}.`);

    switch (r.status) {
      case 'AWAITING_PAYMENT':
        lines.push(`Aprobada automáticamente por la política: ${blocking.join('; ')}.`);
        lines.push(`Link de pago de Reap para el titular de la tarjeta: ${view.paymentUrl ?? '(pendiente)'}`);
        lines.push('Yo no pago ni veo datos de tarjeta: el cargo se autoriza en la página de Reap.');
        break;
      case 'PENDING_APPROVAL':
        lines.push(`Requiere aprobación de ${view.approvers?.join(', ') || 'un aprobador'}. Motivo: ${blocking.join('; ')}.`);
        lines.push('El link de pago de Reap se generará cuando la aprueben.');
        break;
      case 'DENIED': {
        lines.push(`Denegada por la política: ${blocking.join('; ')}.`);
        const alternatives = candidates.slice(1, 3).map((c) => `"${c.name}" (${c.merchant}, ${money(c.minPrice)})`);
        lines.push(
          alternatives.length > 0
            ? `Alternativas permitidas: ${alternatives.join(', ')}. También puedes reducir la cantidad o pedir a un aprobador que ajuste la política.`
            : 'Puedes reducir la cantidad, buscar otro producto o pedir a un aprobador que ajuste la política.',
        );
        break;
      }
      default:
        lines.push(view.nextStep);
    }
    if (excluded) lines.push(excluded);
    return lines.join('\n');
  }

  private excludedText(search: SearchOutcome): string {
    if (search.filteredOut.length === 0) return '';
    const items = search.filteredOut.slice(0, 3).map((f) => `"${f.name}" (${f.merchant}): ${f.message}`);
    return `Excluí ${search.filteredOut.length} resultado(s) por política: ${items.join('; ')}.`;
  }

  private budgetText(departmentId: string): string {
    const row = this.service.budgets().find((b) => b.departmentId === departmentId);
    if (!row) return `No conozco el departamento "${departmentId}".`;
    const c = row.currency;
    return (
      `Presupuesto de ${row.name} (${row.month}): ${row.monthlyBudget.toFixed(2)} ${c}. ` +
      `Gastado ${row.committed.toFixed(2)}, reservado ${row.reserved.toFixed(2)}, disponible ${row.remaining.toFixed(2)} ${c}. ` +
      `Autoaprobación hasta ${row.autoApproveUnder.toFixed(2)} ${c}; tope por compra ${row.hardCapPerPurchase.toFixed(2)} ${c}; ` +
      `aprobadores: ${row.approvers.join(', ') || 'cualquiera'}.`
    );
  }

  private async status(requestId: string, input: AgentInput): Promise<{ reply: string; requestIds: string[] }> {
    try {
      const current = this.service.get(requestId);
      if (current.requester.email.toLowerCase() !== input.requester.email.toLowerCase()) {
        return { reply: 'Solo puedo consultar solicitudes tuyas.', requestIds: [] };
      }
      const r = await this.service.refresh(requestId);
      const v = describeRequest(r, { approvers: approversFor(this.service.getPolicy(), r.departmentId) });
      return {
        reply: `Solicitud ${r.id}: ${v.product} x${v.quantity}, ${v.total}. Estado: ${STATUS_LABELS[r.status]}. ${v.nextStep}${v.paymentUrl ? `\nLink de pago: ${v.paymentUrl}` : ''}`,
        requestIds: [r.id],
      };
    } catch (e) {
      return { reply: `No pude consultar ${requestId}: ${errorMessage(e)}`, requestIds: [] };
    }
  }
}
