# Cómo conectar el agente de compras

SpendGuard **no trae agente**. Deja el espacio listo para que el agente se construya por separado y se conecte sin tocar el núcleo (política, presupuesto, Reap).

Mientras no haya agente conectado, `POST /api/agent/chat` responde con un mensaje de "agente no conectado" y `GET /api/health` reporta `agentMode: "none"`.

---

## La regla de oro

El agente **propone**, SpendGuard **decide**.

- El agente nunca paga y nunca ve datos de tarjeta. El único camino para comprar es la herramienta `propose_purchase` (o `POST /api/requests`), que cotiza con Reap, aplica la política de la empresa y reserva presupuesto.
- **Quién compra y para qué departamento vienen de la sesión, nunca del modelo.** El modelo no puede cambiar `requester` ni `departmentId`.
- El nombre del producto, el merchant y el precio que se juzgan los obtiene SpendGuard de Reap; no se confía en lo que diga el modelo.
- El link de pago de Reap solo existe si la compra se autoaprobó o la aprobó un humano autorizado.

---

## Dos formas de conectarlo

### Opción A (recomendada): dentro del mismo proceso

Implementar la interfaz `Agent` de [`src/agent/types.ts`](../src/agent/types.ts):

```ts
export interface Agent {
  readonly mode: AgentMode;                 // aparece en /api/health, p. ej. 'external' o 'claude'
  chat(input: AgentInput): Promise<AgentResult>;
}

interface AgentInput {
  message: string;                          // lo que escribió el usuario
  requester: { id: string; email: string }; // de la sesión
  departmentId: string;                     // de la sesión
  history?: unknown[];                      // estado opaco que devolviste en el turno anterior
  shippingAddress?: ShippingAddress;
}

interface AgentResult {
  reply: string;                            // respuesta para el usuario
  requestIds: string[];                     // solicitudes creadas o consultadas (la API las expande)
  history: unknown[];                       // estado opaco para el siguiente turno
  mode: AgentMode;
}
```

Y registrarlo en [`src/server.ts`](../src/server.ts):

```ts
import { MyAgent } from './agent/my-agent';

const { app, service, agent } = await buildApp({
  config,
  agent: (service) => new MyAgent(service, config), // fábrica: recibe el PurchaseService
});
```

`buildApp({ agent })` acepta una instancia o una fábrica `(service) => Agent`.

### Opción B: agente externo por HTTP

Si el agente vive en otro servicio (Python, otro framework, MCP, etc.), puede usar directamente la API REST. Ver la sección [API REST para un agente externo](#api-rest-para-un-agente-externo). En ese caso `/api/agent/chat` queda con el placeholder o puede reenviar al servicio externo con un `Agent` delgado.

---

## Las herramientas ya hechas

[`src/agent/tools.ts`](../src/agent/tools.ts) trae todo lo necesario para darle herramientas a un LLM sin poder saltarse la política:

| Export | Para qué |
|---|---|
| `TOOL_DEFINITIONS` | Definiciones en formato JSON Schema (`name`, `description`, `input_schema`), listas para pasarlas como `tools` a la API de Anthropic (o adaptarlas a OpenAI/MCP). |
| `AgentToolbox` | `new AgentToolbox(service, session).execute(name, input)` ejecuta una herramienta. Valida la entrada con zod, nunca lanza por errores de negocio o de Reap y regresa `{ content, isError, requestIds }`. |
| `describeRequest(r)` | Vista compacta de una solicitud (estado, motivos, link de pago solo cuando aplica, siguiente paso en español). |

Herramientas disponibles:

| Herramienta | Qué hace |
|---|---|
| `search_products` | Busca en los merchants soportados por Reap. Lo que la política bloquearía sale aparte en `filteredOut` con el motivo. |
| `get_product_options` | Detalle del producto, grupos de opciones (cada valor con su `optionId`) y la variante por defecto. |
| `resolve_variant` | Variante exacta (precio, disponibilidad) para una combinación de `optionIds`. |
| `propose_purchase` | **Única forma de comprar.** Cotiza, aplica política y regresa `AUTO_APPROVE` (con link de pago), `REQUIRE_APPROVAL` (quién debe aprobar) o `DENY` (motivos). |
| `get_budget` | Presupuesto del departamento de la sesión: comprometido, reservado, disponible, límite de autoaprobación, tope y aprobadores. |
| `get_request_status` | Estado de una solicitud propia (refresca el pago con Reap). |

`ToolSession` es `{ requester, departmentId, shippingAddress? }` y se arma con lo que llega en `AgentInput`, no con lo que diga el modelo.

---

## Esqueleto de ejemplo (Claude con tool use)

No está en el repo a propósito; es un punto de partida. Requiere `npm install @anthropic-ai/sdk` y `ANTHROPIC_API_KEY`.

```ts
import Anthropic from '@anthropic-ai/sdk';
import type { Agent, AgentInput, AgentResult } from './types';
import { AgentToolbox, TOOL_DEFINITIONS } from './tools';
import type { PurchaseService } from '../services/purchase-service';

const SYSTEM = `Eres el agente de compras de la empresa. Nunca pagas ni ves datos de tarjeta.
Toda compra pasa por propose_purchase, que aplica la política de la empresa.
Explica el resultado: aprobada → comparte el link de pago de Reap; pendiente → quién debe aprobar;
denegada → por qué y sugiere alternativas permitidas. Responde en el idioma del usuario.`;

export class ClaudeAgent implements Agent {
  readonly mode = 'claude';
  private readonly client = new Anthropic();

  constructor(private readonly service: PurchaseService, private readonly model = 'claude-sonnet-5-5') {}

  async chat(input: AgentInput): Promise<AgentResult> {
    const toolbox = new AgentToolbox(this.service, {
      requester: input.requester,
      departmentId: input.departmentId,
      ...(input.shippingAddress ? { shippingAddress: input.shippingAddress } : {}),
    });
    const messages: Anthropic.MessageParam[] = [
      ...((input.history ?? []) as Anthropic.MessageParam[]),
      { role: 'user', content: input.message },
    ];
    const requestIds = new Set<string>();

    for (let step = 0; step < 8; step++) {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 1500,
        system: SYSTEM,
        tools: TOOL_DEFINITIONS as Anthropic.Tool[],
        messages,
      });
      messages.push({ role: 'assistant', content: res.content });

      const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (calls.length === 0) {
        const reply = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
        return { reply, requestIds: [...requestIds], history: messages, mode: this.mode };
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const out = await toolbox.execute(call.name, call.input);
        out.requestIds.forEach((id) => requestIds.add(id));
        results.push({ type: 'tool_result', tool_use_id: call.id, content: out.content, is_error: out.isError });
      }
      messages.push({ role: 'user', content: results });
    }
    return { reply: 'No terminé a tiempo; intenta de nuevo con más detalle.', requestIds: [...requestIds], history: messages, mode: this.mode };
  }
}
```

---

## API REST para un agente externo

Todo responde JSON. Errores: `{ error: { code, message, detail? } }`.

| Método y ruta | Uso |
|---|---|
| `GET /api/health` | Estado: modo de Reap, modo del agente, versión de la política. |
| `GET /api/products/search?q=&maxPrice=&limit=&merchant=` | Búsqueda filtrada por política. |
| `GET /api/products/:id` | Detalle con opciones y variante por defecto. |
| `POST /api/requests` | Proponer compra. Body: `requesterEmail`, `departmentId`, `justification`, `productId`, `quantity`, y opcionales `optionIds`, `declaredMaxTotal`, `shippingAddress`, `shippingOptionId`, `offerCode`, `searchText`, `clientRef`. |
| `GET /api/requests/:id` | Solicitud y su bitácora de auditoría. |
| `POST /api/requests/:id/refresh` | Refresca el estado del pago con Reap. |
| `GET /api/budgets` | Presupuestos por departamento. |

Para reintentos seguros, manda un `clientRef` propio: proponer dos veces con el mismo `clientRef` y el mismo solicitante regresa la primera solicitud en lugar de crear otra.

Aprobar, rechazar y editar la política (`/approve`, `/reject`, `PUT /api/policy`) son acciones humanas del dashboard. **El agente no debe llamarlas.**

---

## Cómo probar el agente

1. `npm install` y luego `npm run dev` (modo mock: sin keys y sin red).
2. Abrir `http://localhost:3000`. El panel de chat usa `/api/agent/chat`.
3. Productos útiles del catálogo simulado (merchants reales de la lista de los organizadores):
   - `p_switches` (divinikey.com, 6.30 USD): se autoaprueba.
   - `p_monitor` (arzopa.com, 139.99 USD): en Ingeniería requiere aprobación (pasa de 150 con envío e impuestos).
   - `p_planter` (liquiddeath.com): merchant bloqueado, se deniega.
   - `p_coffee` (bonescoffee.com): tiene opciones (molido o grano), sirve para probar `optionIds`.
4. Para pruebas automáticas: `buildApp({ config: { ...config, dataFile: null, logger: false }, agent: (s) => new MyAgent(s) })` y `app.inject(...)`. Ver `scripts/smoke.ts` y `test/` como ejemplos.
