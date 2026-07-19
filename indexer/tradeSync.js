/**
 * @file indexer/tradeSync.js
 * @description Reference excerpt from cidex, Hup Labs' multichain event indexer.
 * This is the HupTrade indexing loop verbatim: it replays the contract's four
 * listing events (Listed / ListingUpdated / ListingCancelled / Sold) into the
 * nft_listings and nft_trades tables that the Hup app reads. Included here so
 * judges can see the full offchain half of the protocol without cloning cidex.
 * Not runnable standalone — helpers (logger, pool, getArg, getEventPosition,
 * insertNotification, cursor state) live in the cidex host process.
 */

const TRADE_EVENTS = ['Listed', 'ListingUpdated', 'ListingCancelled', 'Sold']
const HUP_TRADE_ABI = [
  'event Listed(uint256 indexed listingId, address indexed seller, address indexed collection, bytes32 tokenId, bool isLsp8, address token, bool isTokenLsp7, uint256 price, uint256 referralBps)',
  'event ListingUpdated(uint256 indexed listingId, address token, bool isTokenLsp7, uint256 price, uint256 referralBps)',
  'event ListingCancelled(uint256 indexed listingId, bool invalidated)',
  'event Sold(uint256 indexed listingId, address indexed buyer, address indexed referral, address seller, address collection, bytes32 tokenId, address token, bool isTokenLsp7, uint256 price, uint256 feeAmount, uint256 referralAmount)',
]

// IHupTrade.ListingStatus values mirrored into nft_listings.status
const TRADE_STATUS_ACTIVE = 1
const TRADE_STATUS_SOLD = 2
const TRADE_STATUS_CANCELLED = 3

/**
 * Handles the indexing loop for a HupTrade deployment — NFT-in-post sales. The four listing
 * events replay into nft_listings (current terms/status per listing) and nft_trades (one row
 * per Sold). Chunk sizing mirrors runTipperSync — grows while the RPC cooperates, halves and
 * pins the ceiling on range-cap failures.
 * @param {object} info - Network configuration properties and database meta markers.
 */
async function runTradeSync(info) {
  const provider = new ethers.JsonRpcProvider(info.rpc_url)
  const contract = new ethers.Contract(info.address, HUP_TRADE_ABI, provider)
  const contractAddress = contractAddressOrNull(info.address)
  const childLogger = logger.child({ network: info.network_name, contract: info.contract_name })

  if (!contractAddress) {
    childLogger.error({ address: info.address }, 'Skipping trade sync due to invalid contract address')
    provider.destroy?.()
    return
  }

  let lastBlock = Number(info.last_indexed_block ?? Math.max(Number(info.deployed_block ?? 0) - 1, 0))
  if (!Number.isFinite(lastBlock)) lastBlock = 0

  const MIN_CHUNK = 100
  const MAX_CHUNK = 10000
  let chunkSize = MIN_CHUNK
  let chunkCeiling = MAX_CHUNK

  childLogger.info({ lastBlock, chainId: info.network_id }, 'Trade sync process started')

  /**
   * Caches a payment token's symbol/decimals in store_tokens (same shared cache the Bazaar
   * and Tipper runners use) and returns the meta for notification copy.
   */
  const tokenMetaCache = new Map()
  const ensureTokenMeta = async (connection, token, isLsp7) => {
    if (tokenMetaCache.has(token)) return tokenMetaCache.get(token)

    const [existing] = await connection.execute(
      'SELECT symbol, decimals FROM store_tokens WHERE network_id = ? AND token = ? LIMIT 1',
      [info.network_id, token],
    )
    if (existing.length > 0) {
      const meta = { symbol: existing[0].symbol, decimals: Number(existing[0].decimals) }
      tokenMetaCache.set(token, meta)
      return meta
    }

    let symbol
    let decimals
    if (token === ZERO_ADDRESS) {
      symbol = stringOrNull(info.currency_symbol) ?? 'ETH'
      decimals = 18
    } else {
      const tokenContract = new ethers.Contract(token, BAZAAR_TOKEN_META_ABI, provider)
      decimals = Number(await tokenContract.decimals())
      if (isLsp7) {
        symbol = token === BAZAAR_USDC[info.network_id]?.address ? 'USDC' : (await readLsp4Symbol(provider, token)) ?? 'tokens'
      } else {
        try {
          symbol = await tokenContract.symbol()
        } catch (err) {
          symbol = 'tokens'
        }
      }
    }

    await connection.execute('INSERT IGNORE INTO store_tokens (network_id, token, symbol, decimals) VALUES (?, ?, ?, ?)', [
      info.network_id,
      token,
      symbol,
      decimals,
    ])

    const meta = { symbol, decimals }
    tokenMetaCache.set(token, meta)
    return meta
  }

  const formatTradeAmount = (amount, decimals) => {
    const value = Number(ethers.formatUnits(amount, decimals))
    if (!Number.isFinite(value)) return String(amount)
    return new Intl.NumberFormat('en', value > 0 && value < 1 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 4 }).format(value)
  }

  const sync = async () => {
    let connection = null

    try {
      const headBlock = await provider.getBlockNumber()

      if (lastBlock >= headBlock) {
        return setTimeout(sync, 10000)
      }

      const toBlock = Math.min(lastBlock + chunkSize, headBlock)

      let logs
      try {
        logs = await provider.getLogs({ address: info.address, fromBlock: lastBlock + 1, toBlock })
      } catch (err) {
        const message = err?.message ?? ''
        if (/header not found/i.test(message)) {
          return setTimeout(sync, 5000)
        }
        if (chunkSize > MIN_CHUNK) {
          chunkCeiling = Math.max(Math.floor(chunkSize / 2), MIN_CHUNK)
          chunkSize = chunkCeiling
          childLogger.warn({ err: message, chunkSize }, 'getLogs failed, shrinking trade scan chunk')
          return setTimeout(sync, 2000)
        }
        throw err
      }
      chunkSize = Math.min(chunkSize * 2, chunkCeiling)

      if (logs.length === 0) {
        lastBlock = toBlock
        connection = await pool.getConnection()
        await connection.execute('UPDATE indexer_state SET last_indexed_block = ? WHERE contract_id = ?', [
          lastBlock,
          info.contract_id,
        ])
        connection.release()
        return setTimeout(sync, lastBlock >= headBlock ? 10000 : 250)
      }

      const parsedLogs = []
      for (const log of logs) {
        let parsed
        try {
          parsed = contract.interface.parseLog(log)
        } catch (err) {
          continue
        }
        if (!parsed || !TRADE_EVENTS.includes(parsed.name)) continue
        parsedLogs.push({ log, name: parsed.name, args: parsed.args })
      }

      // Listing state replays in place — Listed/Updated/Cancelled/Sold must apply in
      // chain order within the chunk
      parsedLogs.sort((left, right) => {
        const leftPosition = getEventPosition(left.log)
        const rightPosition = getEventPosition(right.log)
        return leftPosition.blockNumber - rightPosition.blockNumber || leftPosition.logIndex - rightPosition.logIndex
      })

      // Unix-second timestamps for listed_at / sold_at
      const tradeBlockNumbers = [...new Set(parsedLogs.map((item) => item.log.blockNumber))]
      const blockUnixMap = {}
      await Promise.all(
        tradeBlockNumbers.map(async (num) => {
          const block = await provider.getBlock(num)
          blockUnixMap[num] = Number(block.timestamp)
        }),
      )

      connection = await pool.getConnection()

      for (const item of parsedLogs) {
        const { args, log, name } = item
        const eventPosition = getEventPosition(log)
        const listingId = stringOrNull(getArg(args, 'listingId'))
        if (!listingId) continue

        try {
          if (name === 'Listed') {
            const token = String(getArg(args, 'token')).toLowerCase()
            const isTokenLsp7 = Boolean(getArg(args, 'isTokenLsp7'))
            await ensureTokenMeta(connection, token, isTokenLsp7)

            await connection.execute(
              `INSERT INTO nft_listings
                (network_id, listing_id, seller, collection, token_id, is_lsp8, payment_token, is_lsp7, price, referral_bps, status, listed_at, block_number, tx_hash)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE
                seller = VALUES(seller), collection = VALUES(collection), token_id = VALUES(token_id),
                is_lsp8 = VALUES(is_lsp8), payment_token = VALUES(payment_token), is_lsp7 = VALUES(is_lsp7),
                price = VALUES(price), referral_bps = VALUES(referral_bps), status = VALUES(status),
                listed_at = VALUES(listed_at), block_number = VALUES(block_number), tx_hash = VALUES(tx_hash)`,
              [
                info.network_id,
                listingId,
                String(getArg(args, 'seller')).toLowerCase(),
                String(getArg(args, 'collection')).toLowerCase(),
                String(getArg(args, 'tokenId')).toLowerCase(),
                getArg(args, 'isLsp8') ? 1 : 0,
                token,
                isTokenLsp7 ? 1 : 0,
                BigInt(getArg(args, 'price')).toString(),
                Number(getArg(args, 'referralBps')),
                TRADE_STATUS_ACTIVE,
                blockUnixMap[log.blockNumber],
                eventPosition.blockNumber,
                log.transactionHash,
              ],
            )
          } else if (name === 'ListingUpdated') {
            const token = String(getArg(args, 'token')).toLowerCase()
            const isTokenLsp7 = Boolean(getArg(args, 'isTokenLsp7'))
            await ensureTokenMeta(connection, token, isTokenLsp7)

            await connection.execute(
              `UPDATE nft_listings
               SET payment_token = ?, is_lsp7 = ?, price = ?, referral_bps = ?
               WHERE network_id = ? AND listing_id = ?`,
              [
                token,
                isTokenLsp7 ? 1 : 0,
                BigInt(getArg(args, 'price')).toString(),
                Number(getArg(args, 'referralBps')),
                info.network_id,
                listingId,
              ],
            )
          } else if (name === 'ListingCancelled') {
            await connection.execute('UPDATE nft_listings SET status = ? WHERE network_id = ? AND listing_id = ?', [
              TRADE_STATUS_CANCELLED,
              info.network_id,
              listingId,
            ])
          } else if (name === 'Sold') {
            const token = String(getArg(args, 'token')).toLowerCase()
            const isTokenLsp7 = Boolean(getArg(args, 'isTokenLsp7'))
            const seller = String(getArg(args, 'seller'))
            const buyer = String(getArg(args, 'buyer'))
            const referral = String(getArg(args, 'referral'))
            const price = BigInt(getArg(args, 'price')).toString()

            const tokenMeta = await ensureTokenMeta(connection, token, isTokenLsp7)

            await connection.execute('UPDATE nft_listings SET status = ? WHERE network_id = ? AND listing_id = ?', [
              TRADE_STATUS_SOLD,
              info.network_id,
              listingId,
            ])

            await connection.execute(
              `INSERT IGNORE INTO nft_trades
                (network_id, listing_id, seller, buyer, referral, collection, token_id, is_lsp8, payment_token, is_lsp7,
                 price, fee_amount, referral_amount, tx_hash, log_index, block_number, sold_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                info.network_id,
                listingId,
                seller.toLowerCase(),
                buyer.toLowerCase(),
                referral === ZERO_ADDRESS ? null : referral.toLowerCase(),
                String(getArg(args, 'collection')).toLowerCase(),
                String(getArg(args, 'tokenId')).toLowerCase(),
                getArg(args, 'isLsp8') ? 1 : 0,
                token,
                isTokenLsp7 ? 1 : 0,
                price,
                BigInt(getArg(args, 'feeAmount') ?? 0n).toString(),
                BigInt(getArg(args, 'referralAmount') ?? 0n).toString(),
                log.transactionHash,
                eventPosition.logIndex,
                eventPosition.blockNumber,
                blockUnixMap[log.blockNumber],
              ],
            )

            // Seller notification + buyer self-activity, keyed by uniq_notification_event so
            // re-scans stay idempotent (same convention as the tipper runner)
            const amountLabel = `${formatTradeAmount(price, tokenMeta.decimals)} ${tokenMeta.symbol}`
            const eventTime = new Date(blockUnixMap[log.blockNumber] * 1000).toISOString().slice(0, 19).replace('T', ' ')
            const notificationContext = {
              networkId: info.network_id,
              contractAddress,
              blockNumber: eventPosition.blockNumber,
              txHash: log.transactionHash,
              logIndex: eventPosition.logIndex,
              createdAt: eventTime,
              entityType: 'nft_listing',
              entityId: listingId,
              data: {
                listing_id: listingId,
                network_id: info.network_id,
                network_name: info.network_name,
                collection: String(getArg(args, 'collection')).toLowerCase(),
                token_id: String(getArg(args, 'tokenId')).toLowerCase(),
                token,
                is_lsp7: isTokenLsp7,
                price,
                symbol: tokenMeta.symbol,
                decimals: tokenMeta.decimals,
                tx_hash: log.transactionHash,
                block_number: eventPosition.blockNumber,
                log_index: eventPosition.logIndex,
              },
            }

            await insertNotification(connection, {
              ...notificationContext,
              recipient: seller,
              actor: buyer,
              actionType: 'nft_sold',
              title: 'NFT sold',
              message: `${shortWallet(buyer)} bought your NFT for ${amountLabel}.`,
            })

            await insertNotification(connection, {
              ...notificationContext,
              recipient: buyer,
              actor: buyer,
              actionType: 'nft_purchased',
              title: 'NFT purchased',
              message: `You bought an NFT for ${amountLabel}.`,
            })
          }
        } catch (err) {
          childLogger.error({ err: err.message, listingId, event: name }, 'Failed to process trade event')
        }
      }

      lastBlock = toBlock
      await connection.execute('UPDATE indexer_state SET last_indexed_block = ? WHERE contract_id = ?', [
        lastBlock,
        info.contract_id,
      ])
      connection.release()
      setTimeout(sync, 1000)
    } catch (err) {
      if (connection) connection.release()
      childLogger.error({ err: err.message, stack: err.stack }, 'Trade sync cycle failed')
      setTimeout(sync, 10000)
    }
  }

  sync()
}
