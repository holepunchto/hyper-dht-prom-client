const idEnc = require('hypercore-id-encoding')
const b4a = require('b4a')
const { MetricsReplyEnc, MetricsReqEnc } = require('./lib/encodings')

const PROTOCOL_NAME = 'prometheus-metrics'

class DhtPromScraper {
  constructor(protomuxRpcClient, promClientPubKey) {
    this.targetKey = idEnc.decode(promClientPubKey)
    this.rpcClient = protomuxRpcClient
  }

  async requestMetrics({ major, minor, timeout } = {}) {
    // Note: can throw
    // (for example on req timeout or if rpc closed halfway through)

    const res = await this.rpcClient.makeRequest(
      this.targetKey,
      'metrics',
      { major, minor },
      {
        requestEncoding: MetricsReqEnc,
        responseEncoding: MetricsReplyEnc,
        timeout,
        protocol: PROTOCOL_NAME,
        id: b4a.allocUnsafe(0)
      }
    )

    return res
  }
}

module.exports = DhtPromScraper
