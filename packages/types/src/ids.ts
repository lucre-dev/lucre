import { z } from "zod";

export const uuid = z.string().uuid();

/** Opaque string ids — plain aliases (no nominal brand friction at boundaries). */
export type EventId = string;
export type AssetId = string;
export type ClientOrderId = string;
export type RunId = string;
export type MoveId = string;
export type MandateVersion = number;

export const EventIdSchema = uuid;
export const AssetIdSchema = z.string().min(1);
export const ClientOrderIdSchema = z.string().min(1).max(48);
export const RunIdSchema = uuid;
export const MoveIdSchema = z.string().min(1);
