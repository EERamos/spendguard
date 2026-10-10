import type { Money } from '../money';

export type { Money };

/**
 * Types mirror the Reap Agentic Payments OpenAPI (docs.reap.global, Reap-Version 2025-02-14).
 * Only the fields SpendGuard reads or sends are modeled.
 */

export interface ShippingAddress {
  firstName: string;
  lastName: string;
  /** E.164, e.g. +14155550100 */
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  /** ISO country code, e.g. US */
  country: string;
}

export interface SearchProductsRequest {
  query: string;
  merchantPreference?: { mode: 'PREFER' | 'ONLY'; merchantName: string };
  context?: { country?: string; currency?: string };
  filters?: { price?: { min?: string; max?: string }; availability?: 'AVAILABLE_ONLY' };
  pagination?: { cursor?: string | null; limit?: number };
}

export interface VariantSummary {
  id: string;
  name?: string;
  price: Money;
  available?: boolean;
}

export interface ProductSummary {
  id: string;
  merchant: { name: string };
  name: string;
  imageUrl?: string;
  priceRange: { min: Money; max: Money };
  available?: boolean;
  previewVariant?: VariantSummary;
}

export interface SearchProductsResponse {
  id: string;
  products: ProductSummary[];
  pagination: { nextCursor: string | null; hasNextPage: boolean; returnedCount: number };
  warnings: string[];
}

export interface MediaItem {
  type: string;
  url: string;
  altText?: string;
}

export interface Variant {
  id: string;
  name?: string;
  options: { name: string; value: string }[];
  price: Money;
  available?: boolean;
  requiresShipping?: boolean;
  media: MediaItem[];
}

export interface ProductOption {
  name: string;
  values: { optionId: string; label: string; available?: boolean }[];
}

export interface ProductDetails {
  id: string;
  merchant: { name: string };
  name: string;
  description?: string;
  media: MediaItem[];
  options: ProductOption[];
  defaultVariant: Variant;
}

export interface ProductDetailsResponse {
  products: ProductDetails[];
  errors: { productId: string; code: string; message?: string }[];
}

export interface QuoteRequest {
  email: string;
  items: { variantId: string; quantity: number }[];
  shippingAddress?: ShippingAddress;
  offerCode?: string;
}

export interface ShippingOption {
  id: string;
  name: string;
  selected: boolean;
  price: Money;
  details?: { key: string; value: string }[];
}

export interface AmountBreakdown {
  itemsSubtotal: Money;
  shipping?: Money;
  tax?: { amount: Money; includedInPrices?: boolean };
  discounts: { name: string; amount: Money }[];
  additionalCharges: { name: string; amount: Money }[];
  finalAmount: Money;
}

export interface Quote {
  id: string;
  shippingOptions: ShippingOption[];
  amountBreakdown: AmountBreakdown;
  /** ISO timestamp. Open the checkout before this passes, or create a new quote. */
  expiresAt: string;
}

export interface CheckoutRequest {
  quoteId: string;
  /** Omit to let the user pick or enter a card on the Reap-hosted approval page. */
  enrollmentId?: string;
  owner: { type: 'CLIENT_REFERENCE'; reference: string; email?: string };
  presentation: { type: 'REDIRECT'; returnUrl: string };
}

export type CheckoutStatus = 'REQUIRES_ACTION' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

export interface Checkout {
  id: string;
  status: CheckoutStatus;
  quoteId?: string;
  enrollmentId?: string | null;
  amount?: Money;
  orderId?: string | null;
  finalAmount?: Money;
  nextAction?: { type: 'REDIRECT'; url: string; expiresAt?: string } | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Everything SpendGuard needs from Reap. Implemented by the live HTTP client and the in-memory mock. */
export interface ReapClient {
  searchProducts(req: SearchProductsRequest): Promise<SearchProductsResponse>;
  getProductDetails(productIds: string[]): Promise<ProductDetailsResponse>;
  resolveVariant(req: { productId: string; optionIds: string[] }): Promise<Variant>;
  createQuote(req: QuoteRequest, idempotencyKey: string): Promise<Quote>;
  getQuote(id: string): Promise<Quote>;
  selectShippingOption(quoteId: string, shippingOptionId: string): Promise<Quote>;
  createCheckout(req: CheckoutRequest, idempotencyKey: string): Promise<Checkout>;
  getCheckout(id: string): Promise<Checkout>;
}
