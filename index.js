const ReadyResource = require('ready-resource')
const b4a = require('b4a')
const RPC = require('protomux-rpc')
const cenc = require('compact-encoding')
const crypto = require('crypto')

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
    // Null operation, to crash before the first actual
    // request in case the metrics themselves are bugged
    await this.promClient.register.metrics()

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

    const rpc = new RPC(socket, { protocol: 'prometheus-metrics' })
    rpc.respond(
      'metrics',
      { responseEncoding: cenc.string },
      async () => {
        // TODO: error path when collecting metrics crashes
        this.emit('metrics-request', { uid, remotePublicKey })
        const metrics = await this.promClient.register.metrics()

        this.emit('metrics-success', { uid })
        return metrics
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
