import { z } from 'zod';
import type { ShippingAddress } from './reap/types';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  // Loopback only by default: the dashboard approves spend and has no login, so it must not be reachable from the LAN.
  HOST: z.string().default('localhost'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  REAP_MODE: z.enum(['mock', 'live']).default('mock'),
  REAP_BASE_URL: z.string().default('https://mx.sandbox.api.reap.global'),
  REAP_API_KEY: z.string().optional(),
  REAP_VERSION: z.string().default('2025-02-14'),
  REAP_CONTACT_EMAIL: z.string().optional(),
  REAP_ENROLLMENT_ID: z.string().optional(),
  REAP_CHECKOUT: z.enum(['live', 'simulated']).default('live'),
  REAP_SIMULATE_CHECKOUT: z.enum(['COMPLETED']).optional(),
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
  /** Interface to bind. `localhost` = this machine only; `0.0.0.0` exposes it to the network. */
  host: string;
  publicBaseUrl: string;
  reapMode: 'mock' | 'live';
  reapBaseUrl: string;
  reapApiKey?: string;
  reapVersion: string;
  /** Email sent to Reap on quotes and checkouts instead of the requester's (Reap rejects reserved TLDs like .test). */
  reapContactEmail?: string;
  /** Reap enrollment id of the company card. Live checkouts need it. */
  reapEnrollmentId?: string;
  /** 'simulated' (live mode only): search and quotes hit Reap, the card-holder approval page is simulated. */
  reapCheckout: 'live' | 'simulated';
  /** Sandbox only: Reap's `X-Simulate-Checkout` header, so a real checkout completes without buying from the merchant. */
  reapSimulateCheckout?: 'COMPLETED';
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
    host: e.HOST,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ''),
    reapMode: e.REAP_MODE,
    reapBaseUrl: e.REAP_BASE_URL,
    reapApiKey: e.REAP_API_KEY,
    reapVersion: e.REAP_VERSION,
    ...(e.REAP_CONTACT_EMAIL ? { reapContactEmail: e.REAP_CONTACT_EMAIL } : {}),
    ...(e.REAP_ENROLLMENT_ID ? { reapEnrollmentId: e.REAP_ENROLLMENT_ID } : {}),
    reapCheckout: e.REAP_CHECKOUT,
    ...(e.REAP_SIMULATE_CHECKOUT ? { reapSimulateCheckout: e.REAP_SIMULATE_CHECKOUT } : {}),
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
