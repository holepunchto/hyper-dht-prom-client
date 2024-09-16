const cenc = require('compact-encoding')

const METRICS_REPLY_VERSION = 0
const MAJOR_VERSION = 1
const MINOR_VERSION = 1

const MetricsReqEnc = {
  preencode (state, m) {
    cenc.uint.preencode(state, m.major || MAJOR_VERSION)
    cenc.uint.preencode(state, m.minor || MINOR_VERSION)
  },

  encode (state, m) {
    cenc.uint.encode(state, m.major || MAJOR_VERSION)
    cenc.uint.encode(state, m.minor || MINOR_VERSION)
  },

  decode (state) {
    const major = cenc.uint.decode(state)
    const minor = cenc.uint.decode(state)
    if (major !== MAJOR_VERSION) {
      throw new Error(`Cannot decode RegisterRequest of other major version ${major} (own major: ${MAJOR_VERSION})`)
    }
    if (minor > MINOR_VERSION) {
      throw new Error(`Cannot decode RegisterRequest of higher minor version ${minor} (own minor: ${MINOR_VERSION})`)
    }

    return { major, minor }
  }

}

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
  MetricsReqEnc,
  MetricsReplyEnc
}
