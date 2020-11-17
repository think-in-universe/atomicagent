const _ = require('lodash')
const asyncHandler = require('express-async-handler')
const router = require('express').Router()
const BigNumber = require('bignumber.js')

const AuditLog = require('../../models/AuditLog')
const Asset = require('../../models/Asset')
const Market = require('../../models/Market')
const Order = require('../../models/Order')
const Job = require('../../models/Job')
const pkg = require('../../../package.json')

router.get('/assetinfo', asyncHandler(async (req, res) => {
  const { query } = req
  const q = _.pick(query, ['code'])

  const result = await Asset.find(q).exec()

  res.json(result.map(r => r.json()))
}))

router.get('/marketinfo', asyncHandler(async (req, res) => {
  const { query } = req
  const q = _.pick(query, ['from', 'to'])

  const result = await Market.find(q).exec()

  res.json(result.map(r => {
    const json = r.json()

    delete json.spread

    return json
  }))
}))

router.post('/order', asyncHandler(async (req, res) => {
  const { body } = req

  const market = await Market.findOne(_.pick(body, ['from', 'to'])).exec()
  if (!market) return res.notOk(400, `Market not found: ${body.from}-${body.to}`)

  const { fromAmount } = body
  if (!(market.min <= fromAmount &&
    fromAmount <= market.max)) {
    return res.notOk(400, `Invalid amount: ${fromAmount} (min: ${market.min}, max: ${market.max})`)
  }

  const order = Order.fromMarket(market, body.fromAmount)

  const addresses = await order.toClient().wallet.getUsedAddresses()
  const balance = await order.toClient().chain.getBalance(addresses)

  if (BigNumber(balance).isLessThan(BigNumber(order.toAmount))) {
    return res.notOk(400, 'Counterparty has insufficient balance')
  }

  const passphrase = body.passphrase || req.get('X-Liquality-Agent-Passphrase')

  if (passphrase) {
    order.setPassphrase(passphrase)
  }

  order.userAgent = req.get('X-Liquality-User-Agent')

  order.setExpiration()

  await Promise.all([
    order.setUsdRates(),
    order.setAgentAddresses()
  ])

  await Promise.all([
    order.save(),
    AuditLog.create({
      orderId: order.orderId,
      orderStatus: order.status,
      context: 'NEW_SWAP'
    })
  ])

  res.json(order.json())
}))

router.post('/order/:orderId', asyncHandler(async (req, res) => {
  const agenda = req.app.get('agenda')
  const { params, body } = req

  const order = await Order.findOne({ orderId: params.orderId }).exec()
  if (!order) return res.notOk(400, `Order not found: ${params.orderId}`)

  if (order.passphraseHash) {
    const passphrase = body.passphrase || req.get('X-Liquality-Agent-Passphrase')

    if (!passphrase) return res.notOk(401, 'You are not authorised')
    if (!order.verifyPassphrase(passphrase)) return res.notOk(401, 'You are not authorised')
  }

  if (!['QUOTE', 'USER_FUNDED_UNVERIFIED'].includes(order.status)) return res.notOk(400, 'Order cannot be updated after funding')

  const fromFundHashExists = await Order.findOne({ fromFundHash: body.fromFundHash }).exec()
  if (fromFundHashExists) return res.notOk(400, `Duplicate fromFundHash: ${body.fromFundHash}`)

  const keysToBeCopied = order.status === 'USER_FUNDED_UNVERIFIED'
    ? ['fromFundHash']
    : ['fromAddress', 'toAddress', 'fromFundHash', 'secretHash']

  for (let i = 0; i < keysToBeCopied.length; i++) {
    const key = keysToBeCopied[i]

    if (!body[key]) return res.notOk(400, `Missing key from request body: ${key}`)

    order[key] = body[key]
  }

  order.status = 'USER_FUNDED_UNVERIFIED'

  const [verifyJobs] = await Promise.all([
    // Prevent duplication of verify job
    agenda.jobs({ 'data.orderId': order.orderId, name: 'verify-user-init-tx' }),
    order.save(),
    AuditLog.create({
      orderId: order.orderId,
      orderStatus: order.status,
      extra: body,
      context: 'SWAP_UPDATE'
    })
  ])

  if (verifyJobs.length === 0) await agenda.now('verify-user-init-tx', { orderId: order.orderId })

  res.json(order.json())
}))

router.get('/order/:orderId', asyncHandler(async (req, res) => {
  const { params, query } = req

  const order = await Order.findOne({ orderId: params.orderId }).exec()
  if (!order) return res.notOk(400, 'Order not found')

  if (order.passphraseHash) {
    const passphrase = query.passphrase || req.get('X-Liquality-Agent-Passphrase')

    if (!passphrase) return res.notOk(401, 'You are not authorised')
    if (!order.verifyPassphrase(passphrase)) return res.notOk(401, 'You are not authorised')
  }

  const json = order.json()

  if (query.verbose === 'true') {
    try {
      json.agent_version = pkg.version

      const [auditLog, jobData] = await Promise.all([
        AuditLog.find({ orderId: params.orderId }).select('-_id -orderId').exec(),
        Job.findByOrderId(params.orderId)
      ])

      json.job_data = jobData
      json.audit_log = auditLog
    } catch (e) {
      json.verbose_error = e.toString()
    }
  }

  res.json(json)
}))

module.exports = router
