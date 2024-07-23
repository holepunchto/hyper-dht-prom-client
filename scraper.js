const crypto = require('crypto')
const ReadyResource = require('ready-resource')
const RPC = require('protomux-rpc')
const { MetricsReplyEnc } = require('./lib/encodings')
const b4a = require('b4a')
const idEnc = require('hypercore-id-encoding')
const safetyCatch = require('safety-catch')

const PROTOCOL_NAME = 'prometheus-metrics'

class DhtPromScraper extends ReadyResource {
  constructor (swarm, promClientPubKey) {
    super()

    promClientPubKey = idEnc.decode(promClientPubKey)

    this.swarm = swarm
    this.targetKey = promClientPubKey

    this.rpc = null
    this.socket = null
    this._currentConnUid = null

    this._boundConnectionHandler = this._connectionHandler.bind(this)
    this.swarm.on('connection', this._boundConnectionHandler)
  }

  _open () {
    // Handles reconnects/suspends
    this.swarm.joinPeer(this.targetKey)
  }

  _close () {
    this.swarm.off('connection', this._boundConnectionHandler)
    this.swarm.leavePeer(this.targetKey)

    if (this.rpc) this.rpc.destroy()
    if (this.socket) this.socket.destroy()
  }

  _connectionHandler (socket, peerInfo) {
    const uid = crypto.randomUUID()

    this.emit('connection-open', { uid, peerInfo, targetKey: this.targetKey })

    if (!b4a.equals(peerInfo.publicKey, this.targetKey)) {
      this.emit('connection-ignore', { uid })
      // Not our connection
      // TODO: confirm this is a sensible approach
      return
    }

    this._currentConnUid = uid // TODO: check if actually needed

    const rpc = new RPC(socket, { protocol: PROTOCOL_NAME })
    rpc.on('close', () => {
      socket.destroy(new Error('protomux-rpc got destroyed')) // Force a reconnect
    })

    socket.on('error', error => {
      safetyCatch(error)
      this.emit('connection-error', { error, uid })
    })
    socket.on('close', () => {
      this.emit('connection-close', { uid })
      if (uid === this._currentConnUid) {
        // No other connection arrived in the the mean time
        // TODO: add tests for the 2 cases
        this.socket = null
        this.rpc = null
        this._currentConnUid = null
      }

      rpc.destroy()
    })

    this.socket = socket
    this.rpc = rpc
  }

  async lookup () {
    if (!this.opened) await this.ready()

    if (!this.rpc) throw new Error('Not connected')

    if (this.rpc && !this.rpc.opened) await this.rpc.fullyOpened()

    // Note: can throw (for example if rpc closed in the mean time)
    const res = await this.rpc.request(
      'metrics',
      null,
      { responseEncoding: MetricsReplyEnc }
    )

    return res
  }
}

module.exports = DhtPromScraper
