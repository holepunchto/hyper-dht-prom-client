const os = require('os')
const ReadyResource = require('ready-resource')
const b4a = require('b4a')
const RPC = require('protomux-rpc')
const crypto = require('crypto')
const safetyCatch = require('safety-catch')
const idEnc = require('hypercore-id-encoding')
const HyperDHT = require('hyperdht')

const { MetricsReplyEnc, MetricsReqEnc } = require('./lib/encodings')
const AliasRpcClient = require('dht-prom-alias-rpc/client')
const ProtomuxRpcClient = require('protomux-rpc-client')

const PROTOCOL_NAME = 'prometheus-metrics'

class DhtPromClient extends ReadyResource {
  constructor (dht, getMetrics, scraperPublicKey, alias, scraperSecret, service, { keyPair, registerIntervalMs = 1000 * 60 * 60, hostname = os.hostname(), protomuxRpcClient = null } = {}) {
    super()

    scraperPublicKey = idEnc.decode(scraperPublicKey)
    scraperSecret = idEnc.decode(scraperSecret)
    this.dht = dht
    this.protomuxRpcClient = protomuxRpcClient || new ProtomuxRpcClient(this.dht)

    const isPromClient = getMetrics.register?.metrics != null
    this.promClient = isPromClient ? getMetrics : null
    this.getMetrics = isPromClient
      ? getMetrics.register.metrics.bind(getMetrics.register)
      : getMetrics

    this.scraperPublicKey = scraperPublicKey
    this.alias = alias
    this.service = service
    this.hostname = hostname

    // It should not use the same keyPair for its server
    // as for the client connections
    // TODO: figure out the exact issue caused by this
    this.serverKeyPair = keyPair || HyperDHT.keyPair()

    const connectionKeepAlive = 5000
    const firewall = this._firewall.bind(this)
    this.server = this.dht.createServer(
      { firewall, connectionKeepAlive },
      this._onconnection.bind(this)
    )

    this.aliasClient = new AliasRpcClient(
      this.scraperPublicKey,
      scraperSecret,
      this.protomuxRpcClient
    )

    this.registerIntervalMs = registerIntervalMs
    this._registerInterval = null
  }

  get publicKey () {
    return this.serverKeyPair.publicKey
  }

  // Never throws
  async _tryRegisterAlias () {
    try {
      const updated = await this.aliasClient.registerAlias(
        this.alias, this.publicKey, this.hostname, this.service
      )
      this.emit('register-alias-success', { updated })
    } catch (e) {
      // Occasonal errors are expected (unreachable etc)
      safetyCatch(e)
      this.emit('register-alias-error', e)
    }
  }

  async _open () {
    await this.server.listen(this.serverKeyPair)

    this._registerInterval = setInterval(
      this._tryRegisterAlias.bind(this), this.registerIntervalMs
    )
    this._tryRegisterAlias() // Never throws
  }

  async _close () {
    if (this._registerInterval) clearInterval(this._registerInterval)
    await this.protomuxRpcClient.close()
    await this.dht.destroy()
  }

  _onconnection (socket) {
    const uid = crypto.randomUUID()
    const remotePublicKey = socket.remotePublicKey
    const remoteAddress = `${socket.rawStream.remoteHost}:${socket.rawStream.remotePort}`

    this.emit('connection-open', { uid, remoteAddress, remotePublicKey })

    socket.on('error', (error) => {
      safetyCatch(error)
      this.emit('connection-error', { error, uid, remotePublicKey })
    })
    socket.on('close', () => {
      this.emit('connection-close', { uid, remotePublicKey })
    })

    const rpc = new RPC(socket, { protocol: PROTOCOL_NAME })
    rpc.on('close', () => {
      // End stream with error (rpc closing is unexpected)
      socket.on('finish', () => socket.destroy(new Error('RPC closed')))

      // Cleanly close write side (flushes all), so we re-open
      socket.end()
    })

    rpc.respond(
      'metrics',
      {
        requestEncoding: MetricsReqEnc,
        responseEncoding: MetricsReplyEnc
      },
      async () => {
        this.emit('metrics-request', { uid, remotePublicKey })
        try {
          const metrics = await this.getMetrics()
          this.emit('metrics-success', { uid, remotePublicKey })
          return {
            success: true,
            metrics
          }
        } catch (error) {
          this.emit('metrics-error', { error, remotePublicKey, uid })
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
      const { host, port } = address
      this.emit('firewall-block', { remotePublicKey, payload, address: `${host}:${port}` })
    }

    return !isScraper
  }

  registerLogger (logger) {
    this.on('firewall-block', ({ remotePublicKey, address }) => {
      logger.info(`Firewall blocked unauthorised connection attempt from ${address} (public key: ${idEnc.normalize(remotePublicKey)})`)
    })

    this.aliasClient.on('alias-attempt', ({ alias, targetKey, hostname, service }) => {
      logger.info(`Prom client attempting to register ${this.alias}->${idEnc.normalize(targetKey)} for service ${service} at host ${hostname}}`)
    })
    this.on('register-alias-success', ({ updated }) => {
      logger.info(`Prom client successfully registered alias ${this.alias} (updated: ${updated})`)
    })
    this.on('register-alias-error', (error) => {
      logger.info(`Prom client failed to register alias ${error.stack}`)
    })

    this.on('connection-open', ({ uid, remotePublicKey }) => {
      logger.info(`Prom client opened connection to ${idEnc.normalize(remotePublicKey)} (uid: ${uid})`)
    })
    this.on('connection-close', ({ uid, remotePublicKey }) => {
      logger.info(`Prom client closed connection to ${idEnc.normalize(remotePublicKey)} (uid: ${uid})`)
    })
    this.on('connection-error', ({ error, uid, remotePublicKey }) => {
      logger.info(`Prom client error on connection to ${idEnc.normalize(remotePublicKey)}: ${error.stack} (uid: ${uid})`)
    })

    if (logger.level === 'debug') {
      this.on('metrics-request', ({ uid, remotePublicKey }) => {
        logger.debug(`Prom client received metrics request from ${idEnc.normalize(remotePublicKey)} (uid: ${uid})`)
      })
      this.on('metrics-success', ({ uid }) => {
        logger.debug(`Prom client successfully processed metrics request (uid: ${uid})`)
      })
    }
    this.on('metrics-error', ({ uid, error }) => {
      logger.info(`Prom client failed to process metrics request: ${error} (uid: ${uid})`)
    })
  }
}

module.exports = DhtPromClient
