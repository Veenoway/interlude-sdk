# What is live on Monad testnet

The one list of addresses and endpoints. Everything below is on Monad testnet (chain 10143) and
was read back from the chain or from the service itself on 2026-09-30, around block 66,974,000.
When another page disagrees with this one, this one is right.

Hub generations are called v1, v2 and v3 here. Elsewhere "v1" also names the protocol's first,
permissioned phase ("v1 is a curated set"), which all three hubs belong to.

## The hub

| | |
|---|---|
| Hub v3 | [`0x98922c6E5e4Bea62761C71D2401c7ec2c26eC43e`](https://testnet.monadscan.com/address/0x98922c6E5e4Bea62761C71D2401c7ec2c26eC43e), deployed at block 66269347 (2026-09-28 00:34 UTC) |
| Its bytecode | `packages/contracts/src/InterludeHub.sol` as of commit `ec48f1b`, built with the repo's `foundry.toml` (solc 0.8.28, 200 optimizer runs): the runtime code on chain is byte for byte `forge build`'s `deployedBytecode`. Built from any later commit up to b492b59 the bytes are the same, metadata hash included: the six files the hub compiles from have not changed since `ec48f1b`. Verified on MonadScan and Sourcify ([Source verification](#source-verification)) |
| Admin | `0xB28E684815b095aB5Fb324214cfEa63d76F3d691` (`allowValidator`, `allowResolver`) |
| Validator | `0xa375CF27eD39491dB8302Ffc3dF4210Ad263eF43`, the hub's `defaultValidator`: bond 3.2 MON, 2.6 MON of it reserved by 26 live delegations (of the 32 its terms allow) |
| Bench | `committeeOf(0xa375…eF43)` returns judges A and B at threshold 2. A session copies this bench when it opens: the cold resolver plus A and B, two votes of three to settle a dispute. The validator set it at block 66886352 (2026-09-30 05:19 UTC); sessions opened before keep the cold resolver alone ([below](#which-bench-a-session-sits-on)) |
| Cold resolver | `0x3dd6202F995EFbAAA1a0Ddc413e46f72f96E147E`, the terms' `resolver`: a dedicated key, neither the validator nor the admin |
| Judge A | `0x895182c2A7cF64b24e98956039A89257C0dDc918`, a bot, Fly app `interlude-judge-a` (`cdg`). It reads Monad through `testnet-rpc.monad.xyz` |
| Judge B | `0x7B2d6F13094BcF274Af25d1F521A051D05615Ae5`, a bot, Fly app `interlude-judge-b` (`ewr`). It reads Monad through Ankr, a second provider |

The hub allows all three as resolvers (`allowedResolver`). How the bots vote, abstain and alert is
in [TRUST-MODEL.md](TRUST-MODEL.md#the-judge-bench).

The validator's terms, as `termsOf(0xa375…eF43)` returns them:

| Term | Value | What it means for an app |
|---|---|---|
| `stakePerDelegation` | 0.1 MON | What a proven fraud in one session forfeits |
| `challengeBond` | 0.5 MON | What a challenger posts |
| `delegationFee` | 0.01 MON | Paid on `openDelegation` |
| `maxBatchInterval` | 3600 s | Silence past this plus a five-minute grace lets anyone `forceClose` |
| `maxDelegationDuration` | 0 | No lease end: a live session is never closed by a stranger for its age |
| `challengeWindow` | 3600 s | How long the app stays locked after a session ends, before `releaseStake` |
| `resolutionWindow` | 1800 s | The clock of each dispute move: every bisection move, and the judges' vote, lands within this of the previous one |
| `maxDiffsPerCommit` | 256 | The most slots one batch may change (also the hub's own ceiling) |
| `maxDelegations` | 32 | Sessions this validator holds at once |
| `timeoutPenaltyBps` | 2000 | 20 % of a challenger's bond goes to the app's beneficiary when the judges time out |
| `spec` | `MonadTen` | The EVM rules a replay must use |
| `open` | true | Taking new delegations |

### Which bench a session sits on

A session keeps the bench it opened with for its whole life. `sessionCommittee` on each live
session reads:

| Bench | Sessions |
|---|---|
| Two of three: the cold resolver, A and B, threshold 2 | Interlude Exchange's two books, opened after the bench was set. The Lie Lab, under the lab validator |
| The cold resolver alone, threshold 1 | Everything the prod validator opened before block 66886352: the eight floors, the old lab Room, the seven salons, Kandle's seven tables and GridBet v3 |

To check any of it yourself:

```bash
RPC=https://testnet-rpc.monad.xyz HUB=0x98922c6E5e4Bea62761C71D2401c7ec2c26eC43e V=0xa375CF27eD39491dB8302Ffc3dF4210Ad263eF43
cast call $HUB "defaultValidator()(address)" --rpc-url $RPC
cast call $HUB "bondOf(address)(uint256,uint256)" $V --rpc-url $RPC
cast call $HUB "committeeOf(address)(address[],uint8)" $V --rpc-url $RPC
cast call $HUB "termsOf(address)((address,uint8,uint256,uint256,uint256,uint64,uint64,uint64,uint64,uint32,uint32,uint16,bool))" \
  $V --rpc-url $RPC
cast call $HUB "sessionOf(address,bytes32)((address,address,uint8,uint8,uint256,uint256,uint64,uint64,uint64,uint64,uint64,uint32))" \
  <app> 0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url $RPC
cast call $HUB "sessionCommittee(address,bytes32)(address[],uint8)" \
  <app> 0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url $RPC
```

## Apps and their nodes

Every node in this section presents chain id 4242, and each serves exactly one contract. All of them are
bound to hub v3 (`hub()`), and each has an `Active` session on it with no lease end, held by the
validator above, except the Lie Lab's, which the lab validator holds. Every node commits through
control-v2.

Every node here but the two lab nodes runs `registry.fly.io/interlude-node:v3-boot` (since
2026-09-30 18:45 UTC: the read-ahead build, plus boots that wait out a rate-limited RPC), the code of
tag `v3` that control-v2 starts new machines from, with read-ahead (`INTERLUDE_READ_AHEAD_RATE`
10) and Ankr as a second read endpoint (`INTERLUDE_BASE_RPC_READS`), both set on these machines. A
machine control-v2 starts gets the same code with the default read-ahead and no second endpoint.

### Public floors

The eight public floors are `Room` contracts (`packages/control/src/public-floors.ts`), one Fly
app each, committing with `INTERLUDE_COMMIT_SECS` 1 (`scripts/fly-floor.sh`).

| Floor | Room | Node | Fly app |
|---|---|---|---|
| Paris | [`0xA116fcaEC711c9D8f64DA409CBE3AF673Fb9084C`](https://testnet.monadscan.com/address/0xA116fcaEC711c9D8f64DA409CBE3AF673Fb9084C) | `https://rpc.interludelayer.xyz` | `floor-eu` |
| California | [`0xE06Db057640F5FAF1deE30E9FD53540411B9B3D2`](https://testnet.monadscan.com/address/0xE06Db057640F5FAF1deE30E9FD53540411B9B3D2) | `https://rpc.us.interludelayer.xyz` | `floor-us` |
| New York | [`0xce3A662cBa0B277D9A75D5D865CaF12C208792a1`](https://testnet.monadscan.com/address/0xce3A662cBa0B277D9A75D5D865CaF12C208792a1) | `https://rpc.ny.interludelayer.xyz` | `floor-ny` |
| Singapore | [`0x9310a3F8E0a9051046D6C845EbF7dDa6F17F6cde`](https://testnet.monadscan.com/address/0x9310a3F8E0a9051046D6C845EbF7dDa6F17F6cde) | `https://rpc.asia.interludelayer.xyz` | `floor-asia` |
| São Paulo | [`0xf33e33db59ca9a9a3d5f6bbed1a4a8d75c29e478`](https://testnet.monadscan.com/address/0xf33e33db59ca9a9a3d5f6bbed1a4a8d75c29e478) | `https://rpc.sa.interludelayer.xyz` | `floor-sa` |
| Tokyo | [`0xA20de0A1cF5dD0eDE3F99e111a482a3b031FbCa9`](https://testnet.monadscan.com/address/0xA20de0A1cF5dD0eDE3F99e111a482a3b031FbCa9) | `https://rpc.tokyo.interludelayer.xyz` | `floor-tokyo` |
| Mumbai | [`0x9377D42C264B2206BAEC5ECF0dd63e60E00fD4b5`](https://testnet.monadscan.com/address/0x9377D42C264B2206BAEC5ECF0dd63e60E00fD4b5) | `https://rpc.mumbai.interludelayer.xyz` | `floor-mumbai`, hosted in Singapore: Fly retired its Mumbai region |
| Johannesburg | [`0x50FFCC5D9ACD1E9091a19577482d0ABbe5E1DB21`](https://testnet.monadscan.com/address/0x50FFCC5D9ACD1E9091a19577482d0ABbe5E1DB21) | `https://rpc.africa.interludelayer.xyz` | `floor-africa` |

### Kandle

[Kandle](https://kandle.live) plays on seven regional tables, one per region, each a GridBet v3.1
(`GridBetV31.sol`) with the quick lock: kandle-feed's quoter prices each tap from a Pyth tick
taken just after the tap lands (`lockQuoted`), so the page shows the locked multiplier without
waiting for the tape ([GRIDBET.md](../apps/kandle/GRIDBET.md)). Kandle sends each visitor to the
nearest table that answers (`GET /api/table`). There is no Mumbai table: India plays on
Singapore's. The tables were opened with `scripts/kandle-regions.sh`
([runbook](runbooks/kandle-regions.md)), and each node was started by control-v2 in its region,
with 10 s commits.

| Region | Table | Cashier | Node |
|---|---|---|---|
| `eu` Paris | [`0x5B2476EBb7f253F3bbae642369abAe3F31b97480`](https://testnet.monadscan.com/address/0x5B2476EBb7f253F3bbae642369abAe3F31b97480) | [`0xAe94B1721d63C3d1e5A44Fc7dc59924b99B188ae`](https://testnet.monadscan.com/address/0xAe94B1721d63C3d1e5A44Fc7dc59924b99B188ae) | `https://il2-eu-5b2476ebb7f253f3.fly.dev` |
| `us` California | [`0x842409731DcfE638bC1C3879E9AD003e0DAbB8B9`](https://testnet.monadscan.com/address/0x842409731DcfE638bC1C3879E9AD003e0DAbB8B9) | [`0x879Ea20d3EA4399523c98e1e060B3f0C810dc0Af`](https://testnet.monadscan.com/address/0x879Ea20d3EA4399523c98e1e060B3f0C810dc0Af) | `https://il2-us-842409731dcfe638.fly.dev` |
| `ny` New York | [`0x1A835eFEd7f2E29CF83aDFe4219469B2fCdbed18`](https://testnet.monadscan.com/address/0x1A835eFEd7f2E29CF83aDFe4219469B2fCdbed18) | [`0x1097b680cc78fe1f898A2dd155E0369DB7C3917E`](https://testnet.monadscan.com/address/0x1097b680cc78fe1f898A2dd155E0369DB7C3917E) | `https://il2-ny-1a835efed7f2e29c.fly.dev` |
| `asia` Singapore | [`0xe4e36E75228F6B71Fef6d7De72102516C67A70c0`](https://testnet.monadscan.com/address/0xe4e36E75228F6B71Fef6d7De72102516C67A70c0) | [`0x93206D49776AEB51bAA53D3423dB4335689bff54`](https://testnet.monadscan.com/address/0x93206D49776AEB51bAA53D3423dB4335689bff54) | `https://il2-asia-e4e36e75228f6b71.fly.dev` |
| `sa` São Paulo | [`0x8Eb3b1ad6388C6628efac136ae37Fc402Ec61D88`](https://testnet.monadscan.com/address/0x8Eb3b1ad6388C6628efac136ae37Fc402Ec61D88) | [`0x5C76a7a644Fa88444001452942341065a29528Cc`](https://testnet.monadscan.com/address/0x5C76a7a644Fa88444001452942341065a29528Cc) | `https://il2-sa-8eb3b1ad6388c662.fly.dev` |
| `tokyo` Tokyo | [`0x2FEAE27c9fb891bC662e71F16127d0830eFACD98`](https://testnet.monadscan.com/address/0x2FEAE27c9fb891bC662e71F16127d0830eFACD98) | [`0x69B96D87EF1E3432481530F21cfAce1eDc9Ef2D9`](https://testnet.monadscan.com/address/0x69B96D87EF1E3432481530F21cfAce1eDc9Ef2D9) | `https://il2-tokyo-2feae27c9fb891bc.fly.dev` |
| `africa` Johannesburg | [`0x6c11C8Ab3628D584ec648e848186D0EF5de96722`](https://testnet.monadscan.com/address/0x6c11C8Ab3628D584ec648e848186D0EF5de96722) | [`0xc332539C324eCD2E97DAF1E74008E9B0Ff1b40bE`](https://testnet.monadscan.com/address/0xc332539C324eCD2E97DAF1E74008E9B0Ff1b40bE) | `https://il2-africa-6c11c8ab3628d584.fly.dev` |

Every table reads the same from the chain:

| | |
|---|---|
| Owner | `0xB28E684815b095aB5Fb324214cfEa63d76F3d691`, who also owns each Cashier |
| kUSD | [`0x032013bDf70696C155e166b388bb0cE8aD65935a`](https://testnet.monadscan.com/address/0x032013bDf70696C155e166b388bb0cE8aD65935a) (`KandleDollar`), one for all seven tables: a player's balance and Wallet are the same whichever table they play |
| Price prints | `LazerLocal` [`0x9f264f16a30045cDb442F01bB5D1b868C8435cb8`](https://testnet.monadscan.com/address/0x9f264f16a30045cDb442F01bB5D1b868C8435cb8), feed id 2, `maxAge` 10 s, signer `0xe6ec27741dD5192a9368D7740E83B739254787D8`. GridBet v3's printer, reused |
| Quoter | `0x099b1549A5F879767A7Ac72257Cf452D344E312A` (`quoter()`), kandle-feed's quote key. It holds no MON: its locks are node transactions |
| Bridge | `0x8332a249C256Bb9bE79e414a48e787eCAE0525cB` (`moneyBridge()`, and each Cashier's `bridge()`), kandle-feed's bridge key |
| Bench | The cold resolver alone, threshold 1: the tables opened before the bench was set |

### Interlude Exchange

Interlude Exchange (Tap until its rename), the on-chain order book on
[the demo's `/exchange`](https://demo.interludelayer.xyz/exchange) (`/tap` redirects there), runs
two `TapBook`s (`packages/contracts/src/examples/TapBook.sol`), one per region, each served by a
node control-v2 started in that region, with 2 s commits (`CONTROL_COMMIT_SECS_BY_APP` in
`packages/control/fly.v2.toml`; 10 s until 2026-09-30). Both books were opened with
`scripts/open-tap-books.sh` ([runbook](runbooks/tap-books.md)), and both sit on the two-of-three
bench.

| Book | TapBook | Node |
|---|---|---|
| `eu` Paris | [`0x69b1Ff7d02fb9fc48FD0Abe39801D45D0984d5A6`](https://testnet.monadscan.com/address/0x69b1Ff7d02fb9fc48FD0Abe39801D45D0984d5A6) | `https://il2-eu-69b1ff7d02fb9fc4.fly.dev` |
| `ny` New York | [`0x181343e34cF598cf8EE4ae6a47c191730F4Bf83e`](https://testnet.monadscan.com/address/0x181343e34cF598cf8EE4ae6a47c191730F4Bf83e) | `https://il2-ny-181343e34cf598cf.fly.dev` |

### Salons

A salon is the demo's 1v1 room behind a code (`/room`, "Create room"). Each salon is a `Room`,
one per region, whose node control-v2 started in that region, with 10 s commits. Create room
opens the lobby in the visitor's own region, or the nearest salon that answers
(`SALON_FALLBACK` in `apps/demo/lib/match.ts`). A code carries its salon (`TOKYO-1A2B3C4D`);
Paris codes stay bare. There is no Mumbai salon: India plays in Singapore's. Paris is the salon
that held every code before; the other six were opened with `scripts/open-regional-salons.sh`
([runbook](runbooks/regional-salons.md)).

| Region | Room | Node |
|---|---|---|
| `eu` Paris | [`0xE9fe7B124980B362ad6cdFa0f1592e80a7cA1BdB`](https://testnet.monadscan.com/address/0xE9fe7B124980B362ad6cdFa0f1592e80a7cA1BdB) | `https://il2-eu-e9fe7b124980b362.fly.dev` |
| `us` California | [`0xa87180C452eF3a9A6a89bd165009d00724489641`](https://testnet.monadscan.com/address/0xa87180C452eF3a9A6a89bd165009d00724489641) | `https://il2-us-a87180c452ef3a9a.fly.dev` |
| `ny` New York | [`0xaF4b0d1BAC73858BE2f9aCFf51488821c35b300a`](https://testnet.monadscan.com/address/0xaF4b0d1BAC73858BE2f9aCFf51488821c35b300a) | `https://il2-ny-af4b0d1bac73858b.fly.dev` |
| `asia` Singapore | [`0x3dA83F6CfADac08B34b7cF396cD45FF3216a55e7`](https://testnet.monadscan.com/address/0x3dA83F6CfADac08B34b7cF396cD45FF3216a55e7) | `https://il2-asia-3da83f6cfadac08b.fly.dev` |
| `sa` São Paulo | [`0xA3BfFE92D23d25EE51b4685D9e6CF6b76C3E5C7C`](https://testnet.monadscan.com/address/0xA3BfFE92D23d25EE51b4685D9e6CF6b76C3E5C7C) | `https://il2-sa-a3bffe92d23d25ee.fly.dev` |
| `tokyo` Tokyo | [`0xB10C652983EEc073b4D8e53c036D55a3BC6dE04c`](https://testnet.monadscan.com/address/0xB10C652983EEc073b4D8e53c036D55a3BC6dE04c) | `https://il2-tokyo-b10c652983eec073.fly.dev` |
| `africa` Johannesburg | [`0x733C44bF3660E8E0Cf24A78AA2f3B098b71cff82`](https://testnet.monadscan.com/address/0x733C44bF3660E8E0Cf24A78AA2f3B098b71cff82) | `https://il2-africa-733c44bf3660e8e0.fly.dev` |

### The Lie Lab and the old lab

| App | Contract | Node | Notes |
|---|---|---|---|
| Lie Lab ([`/lab`](https://demo.interludelayer.xyz/lab)) | `LieLab` [`0x8969cE704EFC7F22376Efe7EE618641020Af9D13`](https://testnet.monadscan.com/address/0x8969cE704EFC7F22376Efe7EE618641020Af9D13) | `https://floor-lielab.fly.dev` | A one-slot app (`poke()` adds 1 to a count) where a visitor makes the node lie, or lies on chain, and watches the bench rule ([runbook](runbooks/judges-and-lie-lab.md)). Fly app `floor-lielab` runs the node's `dishonest` build, which defends its lie, and takes sends only with the operator's bearer (`sendGated`). The session is held by the lab validator `0x467e0F8277Ca322c28463EACC4FEAbd20487923B`, which owns LieLab and serves nothing else, on the two-of-three bench. It is in epoch 7: the lab is re-opened after each slash. The lab validator is allowed on hub v3, with a bond of 0.4 MON and its own terms: stake 0.02 MON, challenge bond 0.01 MON, 600 s per move, at most 2 sessions, closed to new delegations. The conductor, `interlude-lielab`, runs the visitor's scenarios ([Services](#services)) |
| Old lab (`?floor=lab`) | `Room` [`0xEf6471cDB5b811175F3eFCd8e9493f513bE5A696`](https://testnet.monadscan.com/address/0xEf6471cDB5b811175F3eFCd8e9493f513bE5A696) | `https://floor-lab.fly.dev` | A Room served by the node's `dishonest` build (`/health` says `dishonest: true`), built so control could have it publish a falsified batch for a challenger to catch. **That demo stays off on hub v3; the Lie Lab above replaces it.** The Room's session is held by the production validator `0xa375…eF43`, which is also the Room's `owner()` and `slashBeneficiary()` and the delegation's beneficiary, so a slash there would pay half the stake back to the validator it was taken from. Control refuses to falsify a batch in that state (`CONTROL_LAB_ALLOW_PROD_VALIDATOR` is not set). Its bench is the cold resolver alone. `interlude-watcher-lab` replays it |

## Services

| Service | URL | What it is |
|---|---|---|
| Control plane | `https://control.interludelayer.xyz` | Fly app `interlude-control-v2` (`packages/control/fly.v2.toml`), also at `https://interlude-control-v2.fly.dev`. `GET /config` names hub v3, the validator above and `commitGasCap` 25,000,000. It starts partner nodes as `il2-*` machines from `registry.fly.io/interlude-node:v3` and relays the commits of every node on hub v3 |
| Previous control | `https://interlude-control.fly.dev` | Fly app `interlude-control` (`packages/control/fly.toml`), on hub v1 (`GET /config` names `0x3Ef8…D595` and validator `0xB28E…d691`). Control-v2 hands it the machine requests (`/commits`, `/disputes/move`) for apps it does not serve itself (`CONTROL_UPSTREAM_URL`) |
| Price relay, keeper, bridge and quoter | `https://kandle-feed.fly.dev` | `apps/kandle-feed` ([README](../apps/kandle-feed/README.md)), one machine. It relays Pyth Pro's SOL/USD to Kandle's pages, and runs one keeper, one kUSD bridge and one quoter per table: `/keeper/<r>`, `/bridge/<r>`, `/quoter/<r>` for `r` in `eu us ny asia sa tokyo africa` (the routes without a region serve `eu`), and `/health` for the relay. The keeper marks its table's tape every second while anybody plays and idles otherwise; it signs from `0xeB7D6761919E6997744a0a40d65D42D90681e2E8`. The bridge signs from `0x8332…25cB` and the quoter from `0x099b…312A` |
| Judges | `https://interlude-judge-a.fly.dev`, `https://interlude-judge-b.fly.dev` | Judges A and B (`packages/node/fly.judge-a.toml`, `fly.judge-b.toml`). Each finds every session that seats it, and also follows GridBet v3 and the Paris floor, where it only alerts. `/health` lists the sessions it follows, their bench, and `needsHuman` |
| Lie Lab conductor | `https://interlude-lielab.fly.dev` | Fly app `interlude-lielab`. It runs the Lie Lab's two scenarios for the demo page, with the fisherman `0xa6De325D2e517c31e844be2c951fC0310fd65167` (challenges the node's lie) and the liar `0x128776580CA7DEf3850e6a2ad6D9B771d67d4eC2` (posts the visitor's false challenge), and re-opens the lab after a slash. `/health` says whether a scenario can run |
| Watcher | `https://interlude-watcher-lab.fly.dev` | Fly app `interlude-watcher-lab`, `interlude-watcher` following the old lab Room. `GET /verdict?app=<app>&partition=<p>` gives its latest verdict |
| Room demo and explorer | `https://demo.interludelayer.xyz` | Vercel. Live: `/room` names the Paris floor `0xA116…084C`, the build carries the seven salons, `/exchange` names Interlude Exchange's two books, and `/lab` runs the Lie Lab |
| Kandle | `https://kandle.live` | Vercel. Live: `GET /api/table` sends each visitor to the nearest of the seven regional tables that answers |

## Source verification

Hub v3 and LieLab are verified on [MonadScan](https://testnet.monadscan.com/address/0x98922c6E5e4Bea62761C71D2401c7ec2c26eC43e#code)
and on Sourcify (sourcify.dev and MonadVision's instance), each an exact match, metadata hash
included, so the explorers decode the hub's challenges, proofs, votes and verdicts. No other
contract is verified.

| | Hub v3 | LieLab |
|---|---|---|
| Address | `0x98922c6E5e4Bea62761C71D2401c7ec2c26eC43e` | `0x8969cE704EFC7F22376Efe7EE618641020Af9D13` |
| Created by | tx `0x841c78c7…2153fee`, block 66269347, sent by the admin `0xB28E…d691` (`DeployRoom.s.sol`) | tx `0x031162e8…35227b3`, block 66711113, sent by the lab validator `0x467e…923B` (`scripts/open-lielab.sh contract`, `DeployLieLab.s.sol`) |
| Source | `src/InterludeHub.sol:InterludeHub` at `ec48f1b` | `src/examples/LieLab.sol:LieLab` at `679cc44` |
| Constructor | `admin_` = `0xB28E684815b095aB5Fb324214cfEa63d76F3d691` | `hub_` = hub v3, `stakeFloor` = 20000000000000000 wei (0.02 MON) |
| Libraries | none linked: all are internal | none linked |

Both use the repo's `foundry.toml`: solc 0.8.28+commit.7893614a, optimizer on, 200 runs,
evmVersion prague, no via-IR, bytecodeHash ipfs. On chain, each creation input is `forge build`'s
`bytecode` followed by the ABI-encoded arguments. LieLab's runtime differs from
`deployedBytecode` only in the ten slots of its immutable `hub`.

To repeat, from `packages/contracts` of a checkout at the commit above, with `lib/forge-std` in
place and `A` set to `<address> <path>:<name> --chain 10143 --compiler-version 0.8.28+commit.7893614a --num-of-optimizations 200 --evm-version prague`:

    with-keys ETHERSCAN_API_KEY=ETHERSCAN_API_TOKEN -- forge verify-contract $A --verifier etherscan \
      --verifier-url 'https://api.etherscan.io/v2/api?chainid=10143' --constructor-args <abi-encoded args> --watch
    forge verify-contract $A --verifier sourcify
    forge verify-contract $A --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/

`cast abi-encode "constructor(address)" <admin>` and
`cast abi-encode "constructor(address,uint256)" <hub> 20000000000000000` give the arguments.

## Retired

Apps that no longer take play:

| App | Contract | Node | State |
|---|---|---|---|
| GridBet v3 | [`0x33aC093B55A7D035246EE8F739C567341eEE3F1E`](https://testnet.monadscan.com/address/0x33aC093B55A7D035246EE8F739C567341eEE3F1E) | `https://il2-eu-33ac093b55a7d035.fly.dev` | The rollback, no longer played: Kandle and kandle-feed's keeper use the regional tables. Kept delegated on hub v3 and served, so it is one of the validator's 26 live delegations, on the cold resolver alone. Prices from the same `LazerLocal` `0x9f26…5cb8` (feed id 2) |
| GridBet v2 | [`0x7c0b88e89E50b2132f33663bccb54e708099Ae07`](https://testnet.monadscan.com/address/0x7c0b88e89E50b2132f33663bccb54e708099Ae07) | Fly app `il2-eu-7c0b88e89e50b213`, deleted on 2026-09-30 | On hub v2. It had halted (control-v2 refused its commit of batch 492) and was deleted with its volume on 2026-09-30. Its session on hub v2 still reads `Active` |
| Salon v2 | [`0xdCD5207e694d3425EDD812EFd40dB3a511a7f27B`](https://testnet.monadscan.com/address/0xdCD5207e694d3425EDD812EFd40dB3a511a7f27B) | Fly app `il2-eu-dcd5207e694d3425`, deleted on 2026-09-30 | On hub v2. It had halted at batch 133 and was deleted with its volume on 2026-09-30 |

| Hub | Deployed | State |
|---|---|---|
| v2 [`0x62323Dab1B383878C9e9B042664cd43d9c2179c9`](https://testnet.monadscan.com/address/0x62323Dab1B383878C9e9B042664cd43d9c2179c9) | block 65882397 (2026-09-26 15:10 UTC) | The audit fixes ([10-audit-fixes.md](10-audit-fixes.md)), bytecode from commit `fc717e1`. Replaced by v3, which carries every one of them and makes the lease end optional. Nothing has committed to it since the v3 cutover, so its Rooms (Paris was `0x9445c98708565e674Fc0a14d4d589E12588D7140`), GridBet v2 and the v2 salon no longer settle. Its terms required a lease end of at most seven days |
| v1 [`0x3Ef8327F69e09cf721772F345e2A887eA22cD595`](https://testnet.monadscan.com/address/0x3Ef8327F69e09cf721772F345e2A887eA22cD595) | block 60797542 (2026-09-08 15:44 UTC) | Pre-audit bytecode (commit `0a94eb4`: the signed transactions posted at commit, bisection to one transaction). Still serves the partner apps bound to it through the previous control; its validator `0xB28E…d691` reserves 4.7 MON of stake, 47 delegations at 0.1 MON. Tap's first two books, Paris `0xEDef996e977DC4EF23Bd8F889D67A19A29dEB634` and New York `0x3B9de60abBC0cD542d65D363f2A94f05b1657F47`, are among them; the demo no longer points at them. Its resolver was rotated to `0x3dd6…147E` on 2026-09-26, and a delegation keeps the resolver it opened with, so the rotation reaches each app from its next delegation. Anyone may `forceClose` a v1 session after `maxBatchInterval` of silence (no grace) or at its lease end, at most seven days after it opened |
| `0xD5005d6a0fEceE29349CD7f9325a8e429AbDea23` | before v1 | Leftover. It predates `commit(..., raws)`, so no current node commits to it, and its validator still names anvil's public account `0x3C44…93BC` as resolver: never delegate to it |

Hubs v1, v2 and v3 all refuse `0x3C44…93BC` as a resolver (`allowedResolver` is false). An app
binds its hub in its constructor, so an app on a retired hub moves only by being redeployed
against v3 and shipped again (`interlude ship`).
