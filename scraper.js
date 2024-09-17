const { EventEmitter } = require('events')
const crypto = require('crypto')

const RPC = require('protomux-rpc')
const { MetricsReplyEnc, MetricsReqEnc } = require('./lib/encodings')
const b4a = require('b4a')
const idEnc = require('hypercore-id-encoding')
const safetyCatch = require('safety-catch')

const PROTOCOL_NAME = 'prometheus-metrics'

class DhtPromScraper extends EventEmitter {
  constructor (swarm, promClientPubKey, { requestTimeoutMs = 5000 } = {}) {
    super()

    promClientPubKey = idEnc.decode(promClientPubKey)

    this.swarm = swarm
    this.targetKey = promClientPubKey
    this.requestTimeoutMs = requestTimeoutMs

    this.rpc = null
    this.socket = null
    this._currentConnUid = null

    this._boundConnectionHandler = this._connectionHandler.bind(this)

    this.opened = false
    this.closed = false
  }

  // sync open and close, so no ready resource
  ready () {
    if (this.opened) return

    this.swarm.on('connection', this._boundConnectionHandler)

    // Handles reconnects/suspends
    this.swarm.joinPeer(this.targetKey)

    this.opened = true
  }

  close () {
    // Fine to run the close code if we never opened,
    // so we don't guard against that
    if (this.closed) return

    this.swarm.off('connection', this._boundConnectionHandler)
    this.swarm.leavePeer(this.targetKey)

    if (this.rpc) this.rpc.destroy()
    if (this.socket) this.socket.destroy()

    this.closed = true
  }

  _connectionHandler (socket) {
    const uid = crypto.randomUUID()
    const remotePublicKey = socket.remotePublicKey
    const remoteAddress = `${socket.rawStream.remoteHost}:${socket.rawStream.remotePort}`

    if (!b4a.equals(remotePublicKey, this.targetKey)) {
      this.emit('connection-ignore', { uid, remotePublicKey, remoteAddress })
      // Not our connection (probably relevant for another handler)
      return
    }

    this.emit('connection-open', { uid, remotePublicKey, remoteAddress })

    this._currentConnUid = uid // TODO: check if actually needed

    const rpc = new RPC(socket, { protocol: PROTOCOL_NAME })
    rpc.on('close', () => {
      socket.destroy(new Error('protomux-rpc got destroyed')) // Force a reconnect
    })

    socket.on('error', error => {
      safetyCatch(error)
      this.emit('connection-error', { error, uid, remotePublicKey, remoteAddress })
    })
    socket.on('close', () => {
      this.emit('connection-close', { uid, remotePublicKey, remoteAddress })
      if (uid === this._currentConnUid) {
        // No other connection arrived in the the mean time
        this.socket = null
        this.rpc = null
        this._currentConnUid = null
      }

      rpc.destroy()
    })

    this.socket = socket
    this.rpc = rpc
  }

  async requestMetrics ({ major, minor } = {}) {
    // Note: can throw
    // (for example on req timeout or if rpc closed halfway through)

    if (!this.opened) await this.ready()

    if (!this.rpc) throw new Error('Not connected')

    if (this.rpc && !this.rpc.opened) await this.rpc.fullyOpened()

    const res = await this.rpc.request(
      'metrics',
      { major, minor },
      {
        requestEncoding: MetricsReqEnc,
        responseEncoding: MetricsReplyEnc,
        timeout: this.requestTimeoutMs
      }
    )

    return res
  }
}

module.exports = DhtPromScraper
