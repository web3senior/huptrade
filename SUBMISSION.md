# Spark submission — copy-paste sheet

Everything below maps 1:1 to the BuildAnything submission form. Fill the two TODO
links (demo video, social post) before publishing.

---

## Title

HupTrade

## Description (form field, ~1,300 chars)

HupTrade lets you sell an NFT inside a social post. I run Hup (hup.social), a small
onchain social network, and selling an NFT I owned meant screenshotting it, linking an
external marketplace, and hoping my followers followed — my audience is in my feed, but
the transaction lived somewhere else.

With HupTrade, the post is the point of sale. You pick an NFT from the composer, set a
price, and publish; followers see the artwork, traits, price, and a Buy button rendered
in their timeline. One click settles everything in a single transaction: payment split,
optional referral share to the reposter who surfaced the listing, NFT transfer.

It is non-custodial by construction — the token never leaves the seller's wallet; the
contract only holds approval/operator rights and re-verifies ownership at settlement,
so a stale listing can never move a token. One Solidity contract supports ERC721 and
LSP8 collections, priced in native coin, ERC20, or LSP7 tokens, with ERC2771
meta-transactions and Hup's burner session keys so listing feels like posting, not
like signing marketplace ceremonies.

What I learned: making commerce feel native to a feed is mostly a latency problem —
on Monad, list/buy/cancel confirm fast enough that selling an NFT genuinely feels
like publishing a post. Also that referral shares turn distribution (reposts) into
an incentive, which is exactly how a social feed should sell things.

## Project URL

https://hup.social

## GitHub repo

https://github.com/web3senior/huptrade

## Category

mainnet (Monad Mainnet, chainId 143)

## Contract address

0x80218c06A00316687957951036bbD1326a6790C1

https://monadexplorer.com/address/0x80218c06A00316687957951036bbD1326a6790C1

## Demo video

TODO — upload and paste URL. Suggested 3-minute shot list:

1. (0:00) The problem in one line: "My NFT buyers follow me here — not on a marketplace."
2. (0:15) Composer → Sell NFT action → pick collection + token, set price in MON,
   set a referral share → approve + list → publish.
3. (1:15) Show the TradeCard in the feed (artwork, traits, price, Buy).
4. (1:30) Switch to a second account → click Buy → transaction confirms → NFT in
   buyer's wallet, seller gets the "NFT sold" notification.
5. (2:15) Flash the explorer page of the Sold event + the referral payout, close with
   "non-custodial, one contract, ERC721 + LSP8, live on Monad mainnet."

## Social media post URL (Most Viral prize)

TODO — post from Hup itself (self-referential: announce HupTrade in a post that
contains a live listing), cross-post to X with the demo clip.

## What problem are you trying to solve? (form field)

I own NFTs and I run a social app — but selling an NFT meant sending my followers away
to a marketplace. Marketplaces have liquidity but not my audience; my feed has my
audience but no way to transact. The context where buying interest actually happens
(the conversation) and the place where the sale happens were two different websites.

## How is your project the solution to your problem? (form field)

HupTrade embeds a non-custodial NFT sale into the post itself. Listing is a composer
action; buying is one click on a card in the feed. The contract keeps the token in the
seller's wallet (approval-only), re-verifies ownership and transfer rights at
settlement, splits payment between seller, an optional platform fee, and an optional
referral share for the reposter who surfaced the listing — so sharing a listing is
incentivized, and the sale completes exactly where the interest happened. Live on
Monad mainnet, indexed by our open event indexer, running inside hup.social today.

---

## Remaining manual steps

- [x] Create the public GitHub repo and push (github.com/web3senior/huptrade).
- [ ] Cover image (PNG/JPEG/WebP, max 5 MB) — a TradeCard screenshot inside a post works well.
- [ ] Record + upload the demo video (≤3 min), paste URL above and in the form.
- [ ] Publish the social post (on Hup + X), paste URL in the form.
- [ ] Submit before Jul 19, 11:59 PM UTC.
