/*
 * Demo only. When this page runs inside the public demo's phone frame, its
 * WebSockets are handed to the simulated relay in the parent page, and
 * /demo.json comes from there too. Opened on its own, the page is untouched
 * and talks to a real relay as usual. The app's own files are not changed.
 */
;(() => {
  let hub = null
  try {
    if (window.parent !== window) hub = window.parent.__tabSim || null
  } catch {
    hub = null
  }
  if (!hub) return

  class SimSocket {
    constructor(url) {
      this.url = String(url)
      this.readyState = 0
      this.onopen = this.onmessage = this.onclose = this.onerror = null
      setTimeout(() => {
        if (this.readyState !== 0) return
        this.conn = hub.connect(this.url, (text) => {
          if (this.readyState === 1 && this.onmessage) this.onmessage({ data: text })
        })
        this.readyState = 1
        if (this.onopen) this.onopen({})
      }, 60)
    }
    send(text) {
      if (this.readyState === 1) this.conn.send(String(text))
    }
    close() {
      if (this.readyState >= 2) return
      this.readyState = 3
      if (this.conn) this.conn.close()
      setTimeout(() => this.onclose && this.onclose({}), 0)
    }
  }
  SimSocket.CONNECTING = SimSocket.prototype.CONNECTING = 0
  SimSocket.OPEN = SimSocket.prototype.OPEN = 1
  SimSocket.CLOSING = SimSocket.prototype.CLOSING = 2
  SimSocket.CLOSED = SimSocket.prototype.CLOSED = 3
  window.WebSocket = SimSocket

  const realFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href)
    if (url.pathname.endsWith('/demo.json'))
      return Promise.resolve(
        new Response(JSON.stringify(hub.demo), { headers: { 'content-type': 'application/json' } }),
      )
    return realFetch(input, init)
  }
})()
