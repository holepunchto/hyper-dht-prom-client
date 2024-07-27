const cenc = require('compact-encoding')

const METRICS_REPLY_VERSION = 0

const MetricsReplyEnc = {
  preencode (state, m) {
    cenc.uint.preencode(state, METRICS_REPLY_VERSION)
    cenc.bool.preencode(state, m.success)

    if (m.success) {
      cenc.string.preencode(state, m.metrics)
    } else {
      cenc.string.preencode(state, m.errorMessage)
    }
  },

  encode (state, m) {
    cenc.uint.encode(state, METRICS_REPLY_VERSION)
    cenc.bool.encode(state, m.success)

    if (m.success) {
      cenc.string.encode(state, m.metrics)
    } else {
      cenc.string.encode(state, m.errorMessage)
    }
  },

  decode (state) {
    const version = cenc.uint.decode(state)
    if (version > METRICS_REPLY_VERSION) {
      throw new Error(`Cannot decode MetricsReply of future version ${version} (own version: ${METRICS_REPLY_VERSION})`)
    }

    const success = cenc.bool.decode(state)

    const res = { success }

    if (success) {
      res.metrics = cenc.string.decode(state)
    } else {
      res.errorMessage = cenc.string.decode(state)
    }

    return res
  }
}

module.exports = {
  MetricsReplyEnc
}
