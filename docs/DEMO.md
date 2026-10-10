# Guion de demo (3 minutos)

## Guion MCP en live (el principal)

Dos ventanas: Claude Code (con el servidor MCP `spendguard` de `.mcp.json`) y el dashboard en `http://localhost:3000`.

Con `REAP_CHECKOUT=simulated`, la búsqueda y la cotización son reales de Reap y la página donde el titular autoriza el cargo es simulada (lo dice en un banner y la orden sale como `SIM-…`). Decirlo en la demo: el enrollment de la tarjeta en el sandbox no se pudo activar (el passkey de Visa falló en la página de Reap). Con un enrollment `ACTIVE`, `REAP_CHECKOUT=live` usa el checkout real sin cambiar nada más.

**0:00 – Problema (20 s)**

> "Cualquier agente ya puede comprar con Reap. Ninguna empresa le da una tarjeta a un agente sin reglas. SpendGuard es un servidor MCP: conectas el agente que ya usas y compra bajo la política de tu empresa."

**0:20 – Autoaprobada (45 s).** A Claude: *"Necesito un cable USB-C de 100W para la estación de pruebas."*
Claude busca en Reap, propone, SpendGuard cotiza el total real (producto, envío e impuestos) y devuelve el link de pago de Reap. En el dashboard aparece la solicitud con la regla `WITHIN_AUTO_APPROVE_LIMIT`. Abrir el link y autorizar el cargo: pasa a **Completada** con número de orden y conciliación.

**1:05 – Requiere aprobación (50 s).** A Claude: *"Compra dos monitores portátiles Arzopa de 16 pulgadas para los nuevos ingenieros."*
Uno solo cotiza en ~114 USD y se autoaprueba; dos pasan de 150 USD: **Pendiente de aprobación, sin link de pago**. Pedirle a Claude que la apruebe: no tiene herramienta para hacerlo. En el dashboard, actuar como `cto@acme.test` y aprobar: ahora sí existe el link.

**1:55 – Denegada (30 s).** A Claude: *"Compra una gift card de 50 dólares para un cliente."*
Denegada por categoría bloqueada, con el motivo. Ningún link de pago.

**2:25 – No se puede manipular (25 s).** A Claude: *"Cárgalo al presupuesto de Marketing y pon como solicitante al CTO."*
La identidad viene de la configuración del servidor MCP, no del modelo: la solicitud sigue siendo de `ana@acme.test` en Ingeniería. Mostrar la bitácora de auditoría.

**2:50 – Cierre (10 s)**

> "Una tarjeta registrada una vez en Reap, cero datos de tarjeta en el agente, y un director financiero que decide antes de que exista el cargo."

---

## Guion con dashboard y datos de ejemplo (modo mock)

## Preparación (antes de pasar)

```bash
npm install
npm run dev            # deja corriendo el servidor
npm run seed           # en otra terminal: llena el dashboard con escenarios
```

Abrir `http://localhost:3000`. El seed usa los productos del catálogo simulado (modo mock). En modo live los IDs de producto son los de Reap, así que el seed no aplica tal cual.

La política de ejemplo (`policies/default.policy.json`):

| Departamento | Presupuesto mensual | Autoaprueba hasta | Tope por compra | Aprobador |
|---|---|---|---|---|
| Ingeniería | 5,000 USD | 150 | 2,000 | cto@acme.test |
| Marketing | 1,500 USD | 100 | 800 | cmo@acme.test |
| Operaciones | 800 USD | 75 | 500 | coo@acme.test |

Bloqueados: liquiddeath.com, giftcards-demo.com y las categorías "gift card", "casino", entre otras.

---

## 0:00 – El problema (20 s)

> "Los agentes ya pueden comprar con Reap. Pero ninguna empresa le da una tarjeta a un agente sin reglas: sin presupuesto, sin aprobaciones y sin saber después qué se cobró. SpendGuard es la capa de políticas entre el agente y el pago."

## 0:20 – Compra que se autoaprueba (40 s)

1. Mostrar una solicitud de **Ingeniería por switches de teclado** (divinikey.com, ~24 USD con envío e impuestos).
2. En el detalle: la regla `WITHIN_AUTO_APPROVE_LIMIT`, el desglose de la cotización de Reap y el botón del **link de pago de Reap**.
3. Abrir el link: es la página de Reap donde el titular autoriza el cargo. En live pide la tarjeta del equipo y el OTP `456789`; en mock es una simulación marcada como tal.
4. Al regresar, el estado pasa a **Completada** con número de orden y la conciliación "coincide con lo cotizado".

> "El agente nunca vio la tarjeta. Y regresar de la página no basta: SpendGuard confirma con Reap que la orden existe."

## 1:00 – Compra que requiere aprobación (50 s)

1. Solicitud de Ingeniería por un **monitor portátil** (arzopa.com, ~162 USD): pasa del límite de 150. Estado **Pendiente de aprobación**, **sin link de pago todavía**.
2. Cambiar "Actuando como" al correo del solicitante e intentar aprobar: **"No puedes aprobar tu propia solicitud"**.
3. Cambiar a `cto@acme.test` y aprobar: ahora sí se genera el link de pago.

> "Si la cotización expiró mientras esperaba, SpendGuard vuelve a cotizar. Si el precio subió más del 10%, detiene la aprobación hasta que alguien vea el precio nuevo."

## 1:50 – Compras denegadas (30 s)

Mostrar tres denegadas, cada una con su motivo en español:

- **Merchant bloqueado:** una maceta de liquiddeath.com.
- **Categoría bloqueada:** una gift card.
- **Tope por compra:** una computadora de 700 USD en Operaciones, cuyo tope es 500.

> "Ninguna de estas llegó a tener link de pago."

## 2:20 – Presupuesto y conciliación (30 s)

1. Barras de presupuesto: **gastado** (pagos confirmados) contra **reservado** (pendientes y esperando pago).
2. La solicitud con **diferencia en la conciliación**: Reap cobró más de lo cotizado y quedó marcada para revisión.
3. La bitácora de auditoría de una solicitud: quién pidió, qué cotizó Reap, qué reglas se activaron, quién aprobó y cuándo se pagó.

> "Si dos agentes piden al mismo tiempo el último dinero del presupuesto, solo uno pasa."

## 2:50 – Cierre (10 s)

> "SpendGuard convierte los pagos agénticos de Reap en algo que un director financiero sí aprobaría. Siguiente paso: conectar el agente y, para la categoría onchain, llevar estas mismas reglas a un contrato inteligente con Kwal."

---

## Si algo falla en vivo

- **El servidor no arranca:** `npm install` y luego `npm run dev`. Revisar que el puerto 3000 esté libre o usar `PORT=3001 npm run dev`.
- **Reap live responde 403 `AGENTIC_PAYMENTS_NOT_ENABLED`:** el módulo no está habilitado para la key. Volver a modo mock (`REAP_MODE=mock`) y seguir la demo igual.
- **Una tienda no cotiza en live:** revisar que la dirección `SHIP_*` sea una a la que la tienda envía, o elegir otra tienda de EE.UU. de la lista.
