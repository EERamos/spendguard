import { z } from 'zod';
import type { ShippingAddress } from './reap/types';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  REAP_MODE: z.enum(['mock', 'live']).default('mock'),
  REAP_BASE_URL: z.string().default('https://mx.sandbox.api.reap.global'),
  REAP_API_KEY: z.string().optional(),
  REAP_VERSION: z.string().default('2025-02-14'),
  DATA_FILE: z.string().default('data/store.json'),
  POLICY_FILE: z.string().default('policies/default.policy.json'),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  // Default shipping address. Live sandbox merchants only ship to addresses they serve:
  // the organizers recommend US stores, so the default is a (fictional) US address.
  SHIP_FIRST_NAME: z.string().default('Demo'),
  SHIP_LAST_NAME: z.string().default('Builder'),
  SHIP_PHONE: z.string().default('+14155550100'),
  SHIP_ADDRESS1: z.string().default('1 Market Street'),
  SHIP_ADDRESS2: z.string().optional(),
  SHIP_CITY: z.string().default('San Francisco'),
  SHIP_REGION: z.string().default('CA'),
  SHIP_POSTAL_CODE: z.string().default('94105'),
  SHIP_COUNTRY: z.string().length(2).default('US'),
});

export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  reapMode: 'mock' | 'live';
  reapBaseUrl: string;
  reapApiKey?: string;
  reapVersion: string;
  /** null = keep everything in memory (tests). */
  dataFile: string | null;
  policyFile: string;
  pollIntervalMs: number;
  defaultShipping: ShippingAddress;
  logger: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) {
    try {
      process.loadEnvFile('.env');
    } catch {
      // No .env file: rely on the real environment.
    }
  }
  // Treat empty strings (as in a copied .env.example) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const e = EnvSchema.parse(cleaned);

  if (e.REAP_MODE === 'live' && !e.REAP_API_KEY) {
    throw new Error('REAP_MODE=live requiere REAP_API_KEY (te la entregan en el evento).');
  }

  return {
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ''),
    reapMode: e.REAP_MODE,
    reapBaseUrl: e.REAP_BASE_URL,
    reapApiKey: e.REAP_API_KEY,
    reapVersion: e.REAP_VERSION,
    dataFile: e.DATA_FILE,
    policyFile: e.POLICY_FILE,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    defaultShipping: {
      firstName: e.SHIP_FIRST_NAME,
      lastName: e.SHIP_LAST_NAME,
      phone: e.SHIP_PHONE,
      addressLine1: e.SHIP_ADDRESS1,
      ...(e.SHIP_ADDRESS2 ? { addressLine2: e.SHIP_ADDRESS2 } : {}),
      city: e.SHIP_CITY,
      region: e.SHIP_REGION,
      postalCode: e.SHIP_POSTAL_CODE,
      country: e.SHIP_COUNTRY,
    },
    logger: process.env.NODE_ENV !== 'test',
  };
}
