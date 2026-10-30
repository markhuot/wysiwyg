import type { Schema } from '../schema'
import type { StepJSON } from './steps'

/** The wire format's version. Every message carries it, so a later format can be told apart. */
export const PROTOCOL = 1

/** Where a client's caret and selection are, in positions at `version`. */
export interface Presence {
  clientId: string
  name: string
  color: string
  version: number
  anchor: number
  head: number
}

export type ClientMessage =
  | { v: 1; type: 'hello'; doc: string; clientId: string; schemaHash: string; version: number; wantSizes?: boolean }
  | { v: 1; type: 'steps'; version: number; steps: StepJSON[]; clientId: string }
  | ({ v: 1; type: 'presence' } & Presence)

export type ServerMessage =
  /** The handshake passed. `sizes` is the size index at the client's version, when asked for. */
  | { v: 1; type: 'welcome'; head: number; sizes?: { version: number; sizes: number[] } }
  /** The handshake failed, for a schema mismatch or an unknown version. The server closes the connection. */
  | { v: 1; type: 'refused'; reason: 'schema' | 'version' | 'protocol'; message: string }
  /** Steps `version` onwards, in order, each with the client that made it. Broadcast to everyone, the sender included. */
  | { v: 1; type: 'steps'; version: number; steps: StepJSON[]; clientIds: string[] }
  /** A send that wasn't accepted: another client's steps came first (`version`), or a step didn't apply (`invalid`). */
  | { v: 1; type: 'rejected'; reason: 'version' | 'invalid'; version: number; message: string }
  /** Reserved for a server that prunes old versions: the client's version is gone and it must reload. Never sent yet. */
  | { v: 1; type: 'gone' }
  | ({ v: 1; type: 'presence' } & Presence)
  | { v: 1; type: 'leave'; clientId: string }

/**
 * A short hash of the schema's canonical form: block tags, marks (order
 * matters, it's nesting order) and the default block. FNV-1a, so it's sync
 * and needs no crypto API.
 */
export function schemaHash(schema: Schema): string {
  const canonical = JSON.stringify([schema.blocks, schema.marks, schema.defaultBlock])
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
