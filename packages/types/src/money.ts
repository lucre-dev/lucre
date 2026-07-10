import { z } from "zod";

/**
 * Money is integer minor units (USD cents). Never floats.
 * $10.25 → 1025.
 */
export const MoneyCents = z.number().int();
export type MoneyCents = z.infer<typeof MoneyCents>;

/**
 * Share quantity in micros: 1 share = 1_000_000 micros.
 * Fractional shares stay integer: 0.5 share → 500_000.
 */
export const QtyMicros = z.number().int();
export type QtyMicros = z.infer<typeof QtyMicros>;

export const SHARE_MICROS = 1_000_000 as const;

/** Basis points: 100 bps = 1%. Used for position caps, stops, etc. */
export const Bps = z.number().int().min(0).max(100_00);
export type Bps = z.infer<typeof Bps>;

/** Price in USD micros (1e-6 dollars) for limit prices without floats. */
export const PriceMicros = z.number().int().positive();
export type PriceMicros = z.infer<typeof PriceMicros>;

export function dollarsToCents(dollars: number): MoneyCents {
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: MoneyCents): number {
  return cents / 100;
}

export function sharesToMicros(shares: number): QtyMicros {
  return Math.round(shares * SHARE_MICROS);
}

export function microsToShares(micros: QtyMicros): number {
  return micros / SHARE_MICROS;
}

export function dollarsToPriceMicros(dollars: number): PriceMicros {
  return Math.round(dollars * 1_000_000);
}

export function priceMicrosToDollars(micros: PriceMicros): number {
  return micros / 1_000_000;
}
