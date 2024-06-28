const ReadyResource = require('ready-resource')
const b4a = require('b4a')
const RPC = require('protomux-rpc')
const crypto = require('crypto')

const { MetricsReplyEnc } = require('./lib/encodings')

const PROTOCOL_NAME = 'prometheus-metrics'

class DhtPromClient extends ReadyResource {
  constructor (dht, promClient, scraperPublicKey, { keyPair } = {}) {
    super()

    this.dht = dht
    this.promClient = promClient
    this.scraperPublicKey = scraperPublicKey
    this.keyPair = keyPair || this.dht.defaultKeyPair

    const connectionKeepAlive = 5000
    const firewall = this._firewall.bind(this)
    this.server = this.dht.createServer(
      { firewall, connectionKeepAlive },
      this._onconnection.bind(this)
    )
  }

  get publicKey () {
    return this.keyPair.publicKey
  }

  async _open () {
    await this.server.listen(this.keyPair)
  }

  async _close () {
    await this.dht.destroy()
  }

  _onconnection (socket) {
    const uid = crypto.randomUUID()
    const remotePublicKey = socket.remotePublicKey

    socket.on('error', (error) => {
      this.emit('socket-error', { error, uid, remotePublicKey })
    })

    const rpc = new RPC(socket, { protocol: PROTOCOL_NAME })
    rpc.respond(
      'metrics',
      { responseEncoding: MetricsReplyEnc },
      async () => {
        this.emit('metrics-request', { uid, remotePublicKey })
        try {
          const metrics = await this.promClient.register.metrics()
          this.emit('metrics-success', { uid })
          return {
            success: true,
            metrics
          }
        } catch (error) {
          this.emit('metrics-error', { error, uid })
          return {
            success: false,
            errorMessage: `Failed to obtain metrics (uid ${uid})`
          }
        }
      }
    )
  }

  _firewall (remotePublicKey, payload, address) {
    const isScraper = b4a.equals(
      remotePublicKey,
      this.scraperPublicKey
    )

    if (!isScraper) {
      this.emit('firewall-block', { remotePublicKey, payload, address })
    }

    return !isScraper
  }
}

module.exports = DhtPromClient
