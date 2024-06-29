const cenc = require('compact-encoding')

const METRICS_REPLY_VERSION = 0
const REGISTER_REQ_VERSION = 0
const REGISTER_RESP_ENC = 0

const AliasReqEnc = {
  preencode (state, m) {
    cenc.uint.preencode(state, REGISTER_REQ_VERSION)
    cenc.fixed32.preencode(state, m.secret)
    cenc.string.preencode(state, m.alias)
    cenc.fixed32.preencode(state, m.targetPublicKey)
  },

  encode (state, m) {
    cenc.uint.encode(state, REGISTER_REQ_VERSION)
    cenc.fixed32.encode(state, m.secret)
    cenc.string.encode(state, m.alias)
    cenc.fixed32.encode(state, m.targetPublicKey)
  },

  decode (state) {
    const version = cenc.uint.decode(state)
    if (version > REGISTER_REQ_VERSION) {
      throw new Error(`Cannot decode RegisterRequest of future version ${version} (own version: ${REGISTER_REQ_VERSION})`)
    }

    const res = {
      secret: cenc.fixed32.decode(state),
      alias: cenc.string.decode(state),
      targetPublicKey: cenc.fixed32.decode(state)
    }

    return res
  }
}

const AliasRespEnc = {
  preencode (state, m) {
    cenc.uint.preencode(state, REGISTER_RESP_ENC)
    cenc.bool.preencode(state, m.success)

    if (m.success) {
      cenc.bool.preencode(state, m.updated)
    } else {
      cenc.string.preencode(state, m.errorMessage)
    }
  },

  encode (state, m) {
    cenc.uint.encode(state, REGISTER_RESP_ENC)
    cenc.bool.encode(state, m.success)

    if (m.success) {
      cenc.bool.encode(state, m.updated)
    } else {
      cenc.string.encode(state, m.errorMessage)
    }
  },

  decode (state) {
    const version = cenc.uint.decode(state)
    if (version > REGISTER_RESP_ENC) {
      throw new Error(`Cannot decode AliasResp of future version ${version} (own version: ${REGISTER_RESP_ENC})`)
    }

    const success = cenc.bool.decode(state)

    const res = { success }

    if (success) {
      res.updated = cenc.bool.decode(state)
      // res.scraperPublicKey = cenc.fixed32.decode(state)
    } else {
      res.errorMessage = cenc.string.decode(state)
    }

    return res
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
  MetricsReplyEnc,
  AliasReqEnc,
  AliasRespEnc
}
