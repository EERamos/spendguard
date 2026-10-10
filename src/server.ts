import { buildApp } from './app';
import { loadConfig } from './config';

async function main(): Promise<void> {
  const config = loadConfig();
  // Without an explicit PUBLIC_BASE_URL, follow the port so payment and return links point at this server.
  if (!process.env.PUBLIC_BASE_URL) config.publicBaseUrl = `http://localhost:${config.port}`;

  const { app, service, agent } = await buildApp({ config });

  await app.listen({ port: config.port, host: '0.0.0.0' });

  const reapText =
    config.reapMode === 'live'
      ? `Reap EN VIVO (sandbox) en ${config.reapBaseUrl}, Reap-Version ${config.reapVersion}${config.reapCheckout === 'simulated' ? ' (pago simulado)' : ''}`
      : 'Reap SIMULADO (modo mock, sin red ni keys)';
  const agentText = agent.mode === 'none' ? 'no conectado (implementa Agent en src/agent/types.ts)' : `conectado (${agent.mode})`;
  const ship = config.defaultShipping;
  app.log.info(
    [
      '',
      `SpendGuard escuchando en ${config.publicBaseUrl}`,
      `  Reap:      ${reapText}`,
      `  Agente:    ${agentText}`,
      `  Política:  ${config.policyFile} (versión ${service.getPolicy().version})`,
      `  Datos:     ${config.dataFile ?? 'solo en memoria'}`,
      `  Envío por defecto: ${ship.city}, ${ship.region ?? ''} ${ship.country}`,
      `  Conciliación automática cada ${config.pollIntervalMs} ms`,
    ].join('\n'),
  );
  if (!config.logger) {
    console.log(`SpendGuard escuchando en ${config.publicBaseUrl} · Reap ${config.reapMode} · agente ${agent.mode}`);
  }

  // Reap does not push events to us: poll open checkouts and reconcile completed orders.
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    service
      .reconcileOpen()
      .then((s) => {
        if (s.changed > 0) app.log.info({ ...s }, 'conciliación: checkouts actualizados');
        for (const e of s.errors) app.log.warn(e, 'conciliación: error al consultar Reap');
      })
      .catch((e: unknown) => app.log.error({ err: e }, 'conciliación falló'))
      .finally(() => {
        running = false;
      });
  }, config.pollIntervalMs);
  timer.unref();

  const shutdown = (signal: string) => {
    app.log.info(`Recibí ${signal}, cerrando SpendGuard...`);
    clearInterval(timer);
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  console.error('No se pudo iniciar SpendGuard:', e instanceof Error ? e.message : e);
  process.exit(1);
});
