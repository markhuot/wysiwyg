import type { Schema } from '../schema'
import { childSizes, parseHTML, renderHTML, StepError, type ElementNode } from './model'
import { PROTOCOL, schemaHash, type ClientMessage, type Presence, type ServerMessage } from './protocol'
import { ModelTarget, Step, type StepJSON } from './steps'

export type { ClientMessage, ServerMessage } from './protocol'

export type Receipt = { ok: true; steps: StepJSON[] } | { ok: false; reason: 'version' | 'invalid'; message: string }

/**
 * One document's central authority: it orders every step, numbers the
 * versions and keeps every step since the starting HTML. Steps are applied
 * to a model at the head version, so a step that doesn't apply or breaks the
 * schema is refused before anyone sees it.
 */
export class Authority {
  readonly schemaHash: string
  readonly start: ElementNode
  private readonly steps: StepJSON[] = []
  private readonly clientIds: string[] = []
  private readonly head: ModelTarget

  constructor(
    html: string,
    readonly schema: Schema,
  ) {
    this.schemaHash = schemaHash(schema)
    this.start = parseHTML(html, schema)
    if (!this.start.content.length) throw new StepError('the starting document needs at least one block')
    this.head = new ModelTarget(this.start, schema)
  }

  get version(): number {
    return this.steps.length
  }

  get doc(): ElementNode {
    return this.head.doc
  }

  /** Accepts `steps` made at `version` if that's the head and every one applies cleanly. */
  receive(version: number, steps: readonly StepJSON[], clientId: string): Receipt {
    if (version !== this.version) return { ok: false, reason: 'version', message: `version ${version} is not the head (${this.version})` }
    const target = new ModelTarget(this.head.doc, this.schema)
    const accepted: StepJSON[] = []
    try {
      for (const json of steps) {
        const step = Step.fromJSON(json)
        step.apply(target)
        accepted.push(step.toJSON())
      }
    } catch (e) {
      if (!(e instanceof StepError)) throw e
      return { ok: false, reason: 'invalid', message: e.message }
    }
    this.head.doc = target.doc
    for (const step of accepted) {
      this.steps.push(step)
      this.clientIds.push(clientId)
    }
    return { ok: true, steps: accepted }
  }

  /** Every step from `version` on, or null for a version the server never had. */
  stepsSince(version: number): { steps: StepJSON[]; clientIds: string[] } | null {
    if (!Number.isSafeInteger(version) || version < 0 || version > this.version) return null
    return { steps: this.steps.slice(version), clientIds: this.clientIds.slice(version) }
  }

  /** The document at any version, replayed from the start. */
  docAt(version: number): ElementNode {
    if (version === this.version) return this.head.doc
    const target = new ModelTarget(this.start, this.schema)
    for (const json of this.steps.slice(0, version)) Step.fromJSON(json).apply(target)
    return target.doc
  }

  htmlAt(version = this.version): string {
    return renderHTML(this.docAt(version).content, this.schema)
  }

  /** The size index a client starting from this version's HTML needs. */
  sizesAt(version = this.version): number[] {
    return childSizes(this.docAt(version))
  }

  /** The full step log: the document's history. */
  history(): { step: StepJSON; clientId: string }[] {
    return this.steps.map((step, i) => ({ step, clientId: this.clientIds[i]! }))
  }
}

export interface Connection {
  /** Hand the server a message from this client. */
  receive(message: ClientMessage): void
  /** The client went away. */
  close(): void
}

export interface ServerOptions {
  schema: Schema
  /** The starting HTML for a document id, the first time a client asks for it. */
  html: (doc: string) => string
}

interface Room {
  authority: Authority
  clients: Map<string, (message: ServerMessage) => void>
  presence: Map<string, Presence>
}

/**
 * The multiplayer server, independent of the socket library: `connect`
 * takes a function that sends to one client and returns the handle to feed
 * that client's messages to. Documents live in memory.
 */
export class CollabServer {
  private readonly rooms = new Map<string, Room>()

  constructor(private readonly options: ServerOptions) {}

  authority(doc: string): Authority {
    return this.room(doc).authority
  }

  private room(doc: string): Room {
    let room = this.rooms.get(doc)
    if (!room) {
      room = { authority: new Authority(this.options.html(doc), this.options.schema), clients: new Map(), presence: new Map() }
      this.rooms.set(doc, room)
    }
    return room
  }

  connect(send: (message: ServerMessage) => void): Connection {
    let room: Room | null = null
    let clientId = ''
    const refuse = (reason: 'schema' | 'version' | 'protocol', message: string) => send({ v: PROTOCOL, type: 'refused', reason, message })
    const leave = () => {
      if (!room) return
      room.clients.delete(clientId)
      if (room.presence.delete(clientId)) {
        for (const other of room.clients.values()) other({ v: PROTOCOL, type: 'leave', clientId })
      }
      room = null
    }

    return {
      receive: (message) => {
        if (message?.v !== PROTOCOL) return refuse('protocol', `unsupported protocol ${message?.v}`)
        if (message.type === 'hello') {
          leave()
          const candidate = this.room(String(message.doc))
          const { authority } = candidate
          if (message.schemaHash !== authority.schemaHash) {
            return refuse('schema', `the client's schema (${message.schemaHash}) doesn't match the document's (${authority.schemaHash})`)
          }
          const since = authority.stepsSince(message.version)
          if (!since) return refuse('version', `version ${message.version} is unknown (head ${authority.version})`)
          room = candidate
          clientId = String(message.clientId)
          room.clients.set(clientId, send)
          send({
            v: PROTOCOL,
            type: 'welcome',
            head: authority.version,
            ...(message.wantSizes ? { sizes: { version: message.version, sizes: authority.sizesAt(message.version) } } : {}),
          })
          send({ v: PROTOCOL, type: 'steps', version: message.version, ...since })
          for (const p of room.presence.values()) if (p.clientId !== clientId) send({ v: PROTOCOL, type: 'presence', ...p })
          return
        }
        if (!room) return
        if (message.type === 'steps') {
          const version = room.authority.version
          const receipt = room.authority.receive(message.version, message.steps, clientId)
          if (!receipt.ok) return send({ v: PROTOCOL, type: 'rejected', reason: receipt.reason, version: message.version, message: receipt.message })
          const out: ServerMessage = { v: PROTOCOL, type: 'steps', version, steps: receipt.steps, clientIds: receipt.steps.map(() => clientId) }
          for (const client of room.clients.values()) client(out)
          return
        }
        if (message.type === 'presence') {
          const { clientId: _, v: __, type: ___, ...rest } = message
          const presence: Presence = { ...rest, clientId }
          room.presence.set(clientId, presence)
          for (const [id, client] of room.clients) if (id !== clientId) client({ v: PROTOCOL, type: 'presence', ...presence })
        }
      },
      close: leave,
    }
  }
}
