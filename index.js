const ReadyResource = require('ready-resource')
const b4a = require('b4a')
const RPC = require('protomux-rpc')
const crypto = require('crypto')
const safetyCatch = require('safety-catch')
const idEnc = require('hypercore-id-encoding')

const { MetricsReplyEnc } = require('./lib/encodings')
const AliasRpcClient = require('./lib/alias-rpc-client')

const PROTOCOL_NAME = 'prometheus-metrics'

class DhtPromClient extends ReadyResource {
  constructor (dht, getMetrics, scraperPublicKey, alias, scraperSecret, { keyPair, bootstrap, registerIntervalMs = 1000 * 60 * 60 } = {}) {
    super()

    scraperPublicKey = idEnc.decode(scraperPublicKey)
    scraperSecret = idEnc.decode(scraperSecret)
    this.dht = dht

    const isPromClient = getMetrics.register?.metrics != null
    this.getMetrics = isPromClient
      ? getMetrics.register.metrics.bind(getMetrics.register)
      : getMetrics

    this.scraperPublicKey = scraperPublicKey
    this.alias = alias
    this.keyPair = keyPair || this.dht.defaultKeyPair

    const connectionKeepAlive = 5000
    const firewall = this._firewall.bind(this)
    this.server = this.dht.createServer(
      { firewall, connectionKeepAlive },
      this._onconnection.bind(this)
    )

    this.aliasClient = new AliasRpcClient(
      this.scraperPublicKey,
      scraperSecret,
      { bootstrap }
    )

    this.registerIntervalMs = registerIntervalMs
    this._registerInterval = null
  }

  get publicKey () {
    return this.keyPair.publicKey
  }

  // Never throws
  async _tryRegisterAlias () {
    try {
      const updated = await this.aliasClient.registerAlias(
        this.alias, this.publicKey
      )
      this.emit('register-alias-success', { updated })
    } catch (e) {
      // Occasonal errors are expected (unreachable etc)
      safetyCatch(e)
      this.emit('register-alias-error', e)
    }
  }

  async _open () {
    await this.server.listen(this.keyPair)

    await this.aliasClient.ready()
    this._registerInterval = setInterval(
      this._tryRegisterAlias.bind(this), this.registerIntervalMs
    )

    await this._tryRegisterAlias() // Never throws
  }

  async _close () {
    if (this._registerInterval) clearInterval(this._registerInterval)
    await this.dht.destroy()
    await this.aliasClient.close()
  }

  _onconnection (socket, peerInfo) {
    const uid = crypto.randomUUID()
    const remotePublicKey = socket.remotePublicKey

    this.emit('connection-open', { uid, peerInfo, remotePublicKey })

    socket.on('error', (error) => {
      safetyCatch(error)
      this.emit('connection-error', { error, uid, remotePublicKey })
    })
    socket.on('close', () => {
      this.emit('connection-close', { uid, remotePublicKey })
    })

    const rpc = new RPC(socket, { protocol: PROTOCOL_NAME })
    rpc.on('close', () => { // Destroy socket to force a reconnect
      // TODO: can just be socket.end() (and we don't emit an error)

      // End stream with error (rpc closing is unexpected)
      socket.on('finish', () => socket.destroy(new Error('RPC closed')))

      // Cleanly close write side (flushes all)
      socket.end()
    })

    rpc.respond(
      'metrics',
      { responseEncoding: MetricsReplyEnc },
      async () => {
        this.emit('metrics-request', { uid, remotePublicKey })
        try {
          const metrics = await this.getMetrics()
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
