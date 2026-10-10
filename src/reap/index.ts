import type { AppConfig } from '../config';
import { LiveReapClient } from './client';
import { MockReapClient } from './mock';
import type { ReapClient } from './types';

export function createReapClient(config: AppConfig): ReapClient {
  if (config.reapMode === 'live') {
    if (!config.reapApiKey) throw new Error('REAP_MODE=live requiere REAP_API_KEY');
    return new LiveReapClient({ baseUrl: config.reapBaseUrl, apiKey: config.reapApiKey, version: config.reapVersion });
  }
  return new MockReapClient({ publicBaseUrl: config.publicBaseUrl });
}

export { LiveReapClient, MockReapClient };
export type { ReapClient };
