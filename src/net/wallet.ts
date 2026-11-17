/**
 * Request/response over the wallet's relay. One `Wallet` per connection string.
 *
 * Three outcomes, and the caller must keep them apart:
 *   reply ok      the wallet did it and said so (verified by `readResponse`)
 *   reply error   the wallet refused or failed and said so
 *   timeout       NOTHING IS KNOWN. For `pay_invoice` the money may have
 *                 moved. Never render a timeout as "failed" and never treat it
 *                 as permission to pay some other way; resolve it with
 *                 `lookup_invoice` or wait.
 *
 * Alby Hub 1.24.7 does not answer a connection key it does not know (it logs
 * and returns), so a revoked or mistyped connection also surfaces as a
 * timeout, not as UNAUTHORIZED.
 *
 * The subscription is opened before the request is published; otherwise a
 * fast wallet could answer an ephemeral event before we are listening.
 */
import { KIND_INFO, KIND_RESPONSE, makeRequest, readInfo, readResponse, type Conn, type NwcReply } from '../core/nwc.ts'
import { Relay, type Status } from './relay.ts'

export class WalletTimeout extends Error {
  constructor(method: string) {
    super(`wallet did not answer ${method} in time; outcome unknown`)
  }
}

export class Wallet {
  readonly conn: Conn
  private relay: Relay

  constructor(conn: Conn, onStatus?: (s: Status) => void) {
    this.conn = conn
    this.relay = new Relay(conn.relay, { onStatus })
  }

  /** Public, replayable capability advert. Used to refuse wallets without NIP-44. */
  info(timeoutMs = 8000): Promise<{ methods: string[] }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (stop(), reject(new WalletTimeout('info'))), timeoutMs)
      const stop = this.relay.sub({ kinds: [KIND_INFO], authors: [this.conn.walletPk], limit: 1 }, (ev) => {
        clearTimeout(timer)
        stop()
        try {
          resolve(readInfo(this.conn, ev))
        } catch (e) {
          reject(e as Error)
        }
      })
    })
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<NwcReply> {
    const req = makeRequest(this.conn, method, params, Math.floor(Date.now() / 1000))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (stop(), reject(new WalletTimeout(method))), timeoutMs)
      const stop = this.relay.sub({ kinds: [KIND_RESPONSE], '#e': [req.id] }, (ev) => {
        let reply: NwcReply
        try {
          reply = readResponse(this.conn, req.id, method, ev)
        } catch {
          return // forged or unrelated frame: keep waiting for the real one
        }
        clearTimeout(timer)
        stop()
        resolve(reply)
      })
      this.relay.publish(req).catch((e) => {
        clearTimeout(timer)
        stop()
        reject(e)
      })
    })
  }

  close(): void {
    this.relay.close()
  }
}
