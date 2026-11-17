/**
 * One WebSocket to one relay. Small on purpose: the app needs REQ, EVENT, OK,
 * CLOSED and NIP-42 AUTH, and it needs to survive a phone that keeps losing
 * signal.
 *
 * The relay is outside the trust boundary:
 * - every EVENT frame goes through `parseEvent` before a subscriber sees it;
 * - a publish is "sent" only when the relay's OK arrives. A relay that
 *   swallows the event shows up as a timeout the caller must handle;
 * - subscriptions are re-sent after every reconnect, so a dropped socket loses
 *   time, not messages the relay still stores;
 * - a mobile link often dies without closing the socket. Two things notice:
 *   an unacknowledged publish, and a heartbeat that expects any frame at all
 *   within 40 s. Either abandons the socket and reconnects.
 *
 * `auth` is supplied only for the chat socket. The wallet socket never
 * authenticates, so the relay is not handed a signature linking the chat
 * identity to the wallet connection key. (It can still link them by IP
 * address and timing; see the contract.)
 */
import { parseEvent, type Event } from '../core/event.ts'

export type Filter = Record<string, unknown>
export type Status = 'connecting' | 'open' | 'closed' | 'refused'
type Options = { auth?: (challenge: string, url: string) => Event; onStatus?: (s: Status) => void }
type Pending = { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class Relay {
  private ws: WebSocket | null = null
  private subs = new Map<string, { filter: Filter; onEvent: (e: Event) => void }>()
  private pending = new Map<string, Pending>()
  private nextSub = 0
  private retry = 0
  private stopped = false
  private authId = ''
  /** Bumped after each successful AUTH so subscriptions are re-issued under new ids. */
  private gen = 0
  private lastFrame = 0
  private beat: ReturnType<typeof setInterval>
  readonly url: string
  private opts: Options

  constructor(url: string, opts: Options = {}) {
    this.url = url
    this.opts = opts
    this.beat = setInterval(() => this.heartbeat(), 15000)
    this.connect()
  }

  private connect(): void {
    if (this.stopped) return
    this.opts.onStatus?.('connecting')
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => {
      this.lastFrame = Date.now()
      this.retry = 0
      this.opts.onStatus?.('open')
      this.request()
    }
    ws.onmessage = (m) => this.onFrame(String(m.data))
    ws.onclose = () => this.drop(ws)
    ws.onerror = () => this.drop(ws)
  }

  /** Give up on `ws` now, without waiting for a close handshake that may never finish. */
  private drop(ws: WebSocket): void {
    if (this.ws !== ws) return
    this.ws = null
    ws.onclose = ws.onerror = ws.onmessage = null
    Relay.shut(ws)
    if (this.stopped) return
    this.opts.onStatus?.('closed')
    // 1s, 2s, 4s ... capped at 15s: quick on a blip, gentle on a dead link.
    const wait = Math.min(15000, 1000 * 2 ** this.retry++)
    setTimeout(() => this.connect(), wait)
  }

  /**
   * Close without noise. A browser logs a console error when a socket is
   * closed while still connecting, and this app logs nothing; such a socket is
   * left to close itself the moment it opens.
   */
  private static shut(ws: WebSocket): void {
    if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close()
    else ws.close()
  }

  private heartbeat(): void {
    const ws = this.ws
    if (ws?.readyState !== WebSocket.OPEN) return
    const quiet = Date.now() - this.lastFrame
    if (quiet > 40000) return this.drop(ws)
    // A query that matches nothing: the relay's EOSE is the sign of life.
    if (quiet > 14000) {
      this.send(['CLOSE', 'hb'])
      this.send(['REQ', 'hb', { ids: ['0'.repeat(64)], limit: 1 }])
    }
  }

  private request(): void {
    for (const [id, s] of this.subs) this.send(['REQ', `${id}-${this.gen}`, s.filter])
  }

  private send(frame: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(frame))
    return true
  }

  private onFrame(text: string): void {
    this.lastFrame = Date.now()
    let f: unknown
    try {
      f = JSON.parse(text)
    } catch {
      return
    }
    if (!Array.isArray(f)) return
    if (f[0] === 'EVENT') {
      const ev = parseEvent(f[2])
      if (ev) this.subs.get(String(f[1]).split('-')[0])?.onEvent(ev)
    } else if (f[0] === 'OK') {
      // nostr-rs-relay 0.10.0 refuses an AUTH whose `relay` tag host differs
      // from its configured relay_url. Say so instead of looking empty.
      if (f[1] === this.authId) {
        if (f[2] !== true) return this.opts.onStatus?.('refused')
        // Ask again now that we are authenticated. Under a NEW id: this relay
        // ignores a repeated REQ for an id it already has, so reusing the id
        // would never return the stored events it withheld the first time.
        for (const id of this.subs.keys()) this.send(['CLOSE', `${id}-${this.gen}`])
        this.gen++
        return this.request()
      }
      const p = this.pending.get(String(f[1]))
      if (!p) return
      this.pending.delete(String(f[1]))
      clearTimeout(p.timer)
      if (f[2] === true) p.resolve()
      else p.reject(new Error('relay rejected event: ' + String(f[3] ?? '')))
    } else if (f[0] === 'AUTH' && typeof f[1] === 'string' && this.opts.auth) {
      const auth = this.opts.auth(f[1], this.url)
      this.authId = auth.id
      this.send(['AUTH', auth])
    }
  }

  /** Subscribe until the returned function is called. Survives reconnects. */
  sub(filter: Filter, onEvent: (e: Event) => void): () => void {
    const id = 's' + this.nextSub++
    this.subs.set(id, { filter, onEvent })
    this.send(['REQ', `${id}-${this.gen}`, filter])
    return () => {
      this.subs.delete(id)
      this.send(['CLOSE', `${id}-${this.gen}`])
    }
  }

  /** Resolves when the relay acknowledges the event; rejects on refusal or timeout. */
  publish(ev: Event, timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ev.id)
        // No OK on an open socket: assume the link is dead. A socket that is
        // still connecting sent nothing, and is already the retry.
        if (this.ws?.readyState === WebSocket.OPEN) this.drop(this.ws)
        reject(new Error('relay did not acknowledge in time'))
      }, timeoutMs)
      this.pending.set(ev.id, { resolve, reject, timer })
      const trySend = () => {
        if (!this.pending.has(ev.id)) return
        if (!this.send(['EVENT', ev])) setTimeout(trySend, 250)
      }
      trySend()
    })
  }

  close(): void {
    this.stopped = true
    clearInterval(this.beat)
    for (const p of this.pending.values()) clearTimeout(p.timer)
    if (this.ws) {
      this.ws.onclose = this.ws.onerror = this.ws.onmessage = null
      Relay.shut(this.ws)
    }
  }
}
