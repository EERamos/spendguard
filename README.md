# SpendGuard

**Capa de políticas de gasto para agentes de IA, sobre el Agentic module de Reap.**

Las empresas quieren que sus agentes de IA compren por ellas, pero ningún director financiero le da una tarjeta a un agente sin reglas. SpendGuard se pone entre el agente y el pago:

1. La empresa define reglas: presupuesto mensual por departamento, merchants y categorías bloqueadas, tope por compra, límite de autoaprobación y quién aprueba.
2. El agente busca y propone una compra. SpendGuard la cotiza con Reap y evalúa el **total real cotizado** (producto, envío e impuestos).
3. Antes de que exista un link de pago, el motor de políticas decide:
   - **Autoaprobar**: se abre el checkout de Reap y el titular de la tarjeta autoriza el cargo en la página de Reap.
   - **Requiere aprobación**: un aprobador interno autorizado la revisa en el dashboard; solo entonces se genera el link de pago.
   - **Denegar**: con los motivos, sin crear ningún link de pago.
4. Cuando Reap confirma el pago, SpendGuard **concilia** la orden contra lo cotizado y marca las diferencias.

Reap ya pide que una persona apruebe cada cargo en su página. SpendGuard agrega lo que falta para usarlo en una empresa: decidir **antes** si ese cargo debería existir, con presupuesto, aprobaciones internas y auditoría.

> Hackathon Reap x AIBM Agentic Payments, Ciudad de México, 9 de octubre de 2026. Tema: Gasto empresarial.

---

## Arranque rápido (modo mock, sin keys)

Requiere Node 20.12 o superior.

```bash
npm install
npm run dev          # http://localhost:3000
```

En otra terminal, para llenar el dashboard con escenarios de ejemplo:

```bash
npm run seed
```

En modo mock, Reap se simula en memoria: búsqueda, cotizaciones que expiran, idempotencia, checkout con página de aprobación simulada y conciliación. El catálogo simulado usa **merchants reales de la lista de tiendas soportadas por los organizadores** (divinikey.com, baseus.com, arzopa.com, hypershop.com y otras), así que la demo cuenta la misma historia al pasar a live.

### Verificación

```bash
npm run typecheck    # TypeScript estricto
npm test             # 76 pruebas (motor, ledger, flujo completo, cliente Reap, fallas de Reap, store)
npm run smoke        # flujo de punta a punta sobre la API, en memoria
```

---

## Modo live (sandbox de Reap)

1. `cp .env.example .env`
2. En `.env`: `REAP_MODE=live` y `REAP_API_KEY=` con la key del equipo.
3. Confirmar con Reap si la key es de México (`https://mx.sandbox.api.reap.global`) o de Singapur (`https://sg.sandbox.api.reap.global`) y ajustar `REAP_BASE_URL`.
4. `npm run dev`

Importante para live:

- **Solo funcionan las 152 tiendas de la lista de los organizadores.** Se recomiendan las de Estados Unidos.
- **La dirección de envío debe ser una a la que la tienda envía.** Por defecto se usa una dirección ficticia en EE.UU.; se cambia con las variables `SHIP_*` de `.env`.
- **El pago se autoriza en la página de Reap con la tarjeta del equipo y el OTP `456789`.** Las compras del sandbox son simuladas: no se envía nada ni se mueve dinero real.
- **Nunca se suben keys ni datos de tarjeta al repo.** Viven solo en `.env`, que está en `.gitignore`.
- El módulo agéntico puede responder `403 AGENTIC_PAYMENTS_NOT_ENABLED` hasta que Reap lo habilite para la cuenta.
- Los endpoints live están implementados según la documentación de Reap (`Reap-Version 2025-02-14`), pero **no se han probado contra el sandbox real** porque las keys se entregan en el evento. Ver "Pendientes por validar en live" en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## El agente de compras

SpendGuard **no trae agente**: deja el espacio listo para conectarlo. La guía para construirlo y conectarlo está en **[docs/AGENT_INTEGRATION.md](docs/AGENT_INTEGRATION.md)**: la interfaz `Agent`, las herramientas ya hechas que pasan siempre por la política, un esqueleto con Claude y la API REST para un agente externo.

Mientras no haya agente conectado, `POST /api/agent/chat` responde "agente no conectado".

---

## Qué hay en el repo

```
src/
  domain/        motor de políticas (puro), ledger de presupuesto, esquema de política
  services/      PurchaseService: el único lugar donde se juntan política, presupuesto y Reap
  reap/          cliente HTTP real, mock en memoria, tipos de la API de Reap
  agent/         contrato para el agente + herramientas seguras (sin agente incluido)
  store/         persistencia en JSON (intercambiable por una base de datos)
  app.ts         API REST (Fastify) + página de pago simulada en modo mock
  server.ts      servidor + conciliación automática periódica
web/             dashboard en español (sin dependencias)
policies/        política de ejemplo (Ingeniería, Marketing, Operaciones)
scripts/         smoke (prueba de punta a punta) y seed (datos de demo)
test/            pruebas con vitest
docs/            arquitectura, guion de demo e integración del agente
```

Documentación:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): diseño, flujo, garantías de seguridad y decisiones.
- [docs/DEMO.md](docs/DEMO.md): guion de demo de 3 minutos para los jueces.
- [docs/AGENT_INTEGRATION.md](docs/AGENT_INTEGRATION.md): cómo construir y conectar el agente.

---

## Categorías de premio

- **Problema que más vale la pena resolver** (categoría principal). Control de gasto para agentes: un problema real que toda empresa va a tener en cuanto deje comprar a sus agentes, resuelto con presupuesto, aprobaciones y conciliación.
- **Mejor puente entre onchain y el mundo real** (siguiente paso opcional). Las mismas reglas podrían vivir en un contrato inteligente o usarse con Kwal de Payward, donde el agente paga con una tarjeta respaldada por la wallet del usuario (Ink Sepolia). No está construido; ver [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

Licencia MIT.
