import type { AppConfig } from '../config';
import { LiveReapClient } from './client';
import { HybridReapClient } from './hybrid';
import { MockReapClient } from './mock';
import type { ReapClient } from './types';

export function createReapClient(config: AppConfig): ReapClient {
  if (config.reapMode === 'live') {
    if (!config.reapApiKey) throw new Error('REAP_MODE=live requiere REAP_API_KEY');
    const live = new LiveReapClient({
      baseUrl: config.reapBaseUrl,
      apiKey: config.reapApiKey,
      version: config.reapVersion,
      ...(config.reapSimulateCheckout ? { simulateCheckout: config.reapSimulateCheckout } : {}),
    });
    return config.reapCheckout === 'simulated' ? new HybridReapClient(live, { publicBaseUrl: config.publicBaseUrl }) : live;
  }
  return new MockReapClient({ publicBaseUrl: config.publicBaseUrl });
}

export { HybridReapClient, LiveReapClient, MockReapClient };
export type { ReapClient };
