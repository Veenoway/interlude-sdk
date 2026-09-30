# Vault (optional money module): a stub

Only for apps that custody tokens. A game that just updates coordinates does not use this.

**Read this before building on it: `Vault.sol` is a stub.** It does not inherit `Delegatable`,
so nothing in it is handed to a node and nothing in it runs at the node's speed. Earlier versions
of this page and of the README said "the ephemeral node cannot mint" as if the vault enforced
that for a delegated app. It does not: there is no delegated vault yet, so there is nothing for it
to enforce against.

What exists is the base-chain accounting half of the design:

```
token.balanceOf(vault) >= ledgerTotal + pendingInSum + claimableSum
```

| Bucket | Today | Meant to be |
|---|---|---|
| `ledgerTotal` | Sum of internal `cash`, credited by `deposit()` with what actually arrived | The same, moved by commits once `cash` is delegated |
| `pendingInSum` | Always 0 | Deposits received on Monad while delegated, not yet credited by a commit |
| `claimableSum` | Always 0 | Withdrawals acknowledged by a commit, waiting for `claim()` |

- `deposit()` credits the measured balance delta, not the requested amount, and checks the vault
  still covers what it owes (`claims <= balance`, so a donation cannot brick it).
- `requestWithdraw()` debits and pays immediately, on Monad.
- `claim()` always reverts with `NotImplemented`: it belongs to the delegated withdrawal flow,
  which was never built.
- Token calls accept the three shapes ERC-20s come in (returns true, returns nothing, reverts)
  and refuse `false`.

`MockUSD`, the token the tests and demos use, lets anyone mint. It is a test token, not money.

The delegated version (`cash[user]` as a delegated mapping, deposits pending until a commit
credits them, withdrawals claimable after a commit acknowledges the debit, conservation checked
after every commit) is design, not code. An app that holds value today should keep that value
on the base chain, outside any delegated state.
