# Payrun

**Scheduled, multi-recipient USDC payroll on Arc — lock once, pay everyone on time, no custodian in the middle.**

🌐 **Live app:** https://payrun.kutluhaneth.com

[![Payrun demo video](https://img.youtube.com/vi/_EZcmsbJqsU/maxresdefault.jpg)](https://youtu.be/_EZcmsbJqsU)

▶️ **Demo video:** https://youtu.be/_EZcmsbJqsU

---

## What it does

Payrun lets a payer schedule a batch of USDC payments ("a run") in a single transaction and have them paid out automatically on their due dates by anyone on the network.

1. **Create a run.** The payer adds up to **50 payment lines**. Each line has a recipient, a USDC amount, an optional keeper tip (max 1 USDC) and a due date (up to 730 days ahead). The total of amounts plus tips per run is capped at 500 USDC.
2. **Lock the funds.** `createRun` pulls the full amount (amounts + tips) into the `PayrunVault` contract. The vault has no owner, no admin and no upgrade path — nobody can move locked funds except through the rules below.
3. **Release after the due date.** Once a line is due, *anyone* can call `release` (one line) or `releaseMany` (a batch). The line's amount goes to its recipient, and the tip goes to whoever triggered the release. This makes payouts permissionless: a keeper, the payer, the recipient or a bot can execute them.
4. **Funds only go where the run says.** A locked line can only end up in one of these places:
   - **Recipient** — on release (plus the tip to the releaser);
   - **Back to the payer** — if the recipient **declines** the line, if the payer **cancels** it before its due date (non-committed runs only), or if the payer **reclaims** it once it has been unreleased for 30 days past its due date.
5. **Committed runs cannot be cancelled.** When a run is created with `committed = true`, the payer gives up the right to cancel any of its lines. Recipients get a hard guarantee that the payment will be available on the due date.

### Line lifecycle

```
            ┌──────────── release / releaseMany (after dueAt, anyone) ───▶ Paid
            │
 Pending ───┼──────────── decline (recipient, any time) ────────────────▶ Declined  (refund to payer)
            │
            ├──────────── cancel (payer, before dueAt, non-committed) ───▶ Cancelled (refund to payer)
            │
            └──────────── reclaimStale (payer, after dueAt + 30 days) ───▶ Reclaimed (refund to payer)
```

### App pages

| Route | Purpose |
|---|---|
| `/` | Overview and wallet connection |
| `/new` | Create a run: editable table of up to 50 lines, then approve USDC and `createRun` |
| `/run/:id` | Run details with per-line status, countdowns and actions (release, decline, cancel, reclaim) |
| `/me` | Your runs as a payer and your incoming lines as a recipient (paginated) |
| `/keepers` | Scan for due lines, release them and earn tips |

## Built with Arc Studio

Payrun was built in [Arc Studio](https://studio.arc.io): the `PayrunVault` contract, its Foundry test suite and the React frontend were all developed there, and the app keeps Studio's project layout (Vite + wagmi frontend, Foundry contracts, `AGENTS.md` project memory). Payrun is a submission to the Arc Studio microgrant program.

## Deployments

### Arc Mainnet (chain ID `5042`)

| | |
|---|---|
| **PayrunVault** | [`0x77152ae071414d967313827587e477a7b6422896`](https://explorer.arc.io/address/0x77152ae071414d967313827587e477a7b6422896) |
| **Source verification** | [Sourcify — exact match](https://sourcify.dev/server/v2/contract/5042/0x77152ae071414d967313827587e477a7b6422896) |
| **USDC** | `0x3600000000000000000000000000000000000000` |
| **Deployer** | `0xdDdA78690198398Ea24C32FaBA940Ed9582d3681` |

**First mainnet run (#1)**

- Created: [`0x670ae198…6330dd85a`](https://explorer.arc.io/tx/0x670ae198a879fbd33d492d72d5a087e330d3b5eb4ead1b75f944fc66330dd85a)
- Released: [`0x2a0a9b30…e76fe19f98`](https://explorer.arc.io/tx/0x2a0a9b309af4dab4746044d8620c816f0c565aa90bd7da5f433894e76fe19f98)

### Arc Testnet (chain ID `5042002`)

| | |
|---|---|
| **PayrunVault** | [`0x89e43c3f321b540713de4d6cfdd4076a8e277d11`](https://explorer.testnet.arc.io/address/0x89e43c3f321b540713de4d6cfdd4076a8e277d11) |
| **USDC** | `0x3600000000000000000000000000000000000000` |

## Security

- **107 Foundry tests, all passing** — unit, fuzz and invariant tests in [`contracts/test/PayrunVault.t.sol`](contracts/test/PayrunVault.t.sol) and [`contracts/test/PayrunVaultInvariant.t.sol`](contracts/test/PayrunVaultInvariant.t.sol). Run them with `forge test`.
- **Design choices in the contract** ([`contracts/PayrunVault.sol`](contracts/PayrunVault.sol)):
  - No owner, admin, pause or upgrade functions; no `receive`/`fallback`, so native value is rejected.
  - OpenZeppelin `SafeERC20` for all transfers and `ReentrancyGuard` on every public state-changing function (the per-line helper used by `releaseMany` can only be called by the vault itself).
  - Checks-effects-interactions: a line's status is updated before any transfer.
  - Balance check on deposit: `createRun` reverts unless the vault received exactly the expected amount.
  - Recipient validation: the zero address, the vault itself, the token contract and the payer cannot be recipients.
  - `releaseMany` isolates each line in its own call, so one failing transfer leaves that line `Pending` without blocking the rest; out-of-gas is distinguished from a real transfer failure.
  - Hard caps: 50 lines per run, 500 USDC per run (amounts + tips), 1 USDC max tip, 730-day max horizon.
- No third-party audit report is included in this repository. The vault is capped at small amounts by design — use at your own risk.

## Local development

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 (npm also works)
- [Foundry](https://getfoundry.sh) for contract work
- A browser wallet (e.g. MetaMask) with Arc or Arc Testnet configured

### Install and run

```bash
git clone https://github.com/kutluhaneth46/payrun.git
cd payrun
bun install            # installs from bun.lock
cp .env.example .env   # optional — defaults target Arc mainnet
bun run dev            # http://localhost:5173
```

### Build and type-check

```bash
bun run typecheck      # tsc --noEmit
bun run build          # production build into dist/
```

### Contracts

```bash
forge build            # or: bun run contracts:build
forge test             # or: bun run contracts:test  (unit + fuzz + invariant)
```

`forge-std` is vendored under `lib/`; OpenZeppelin contracts are resolved from `node_modules`, so run `bun install` before `forge build`.

### Environment variables

All variables are optional.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_CHAIN` | `mainnet` | `mainnet` (Arc, 5042) or `testnet` (Arc Testnet, 5042002) — selects the active chain |
| `VITE_VAULT_ADDRESS_MAINNET` | `0x7715…2896` | Override the mainnet vault address |
| `VITE_VAULT_ADDRESS_TESTNET` | `0x89e4…7d11` | Override the testnet vault address |

## Project structure

```
.
├── contracts/
│   ├── PayrunVault.sol              # The vault contract
│   ├── script/                      # Foundry deploy scripts (direct + CREATE2)
│   └── test/                        # Unit, fuzz and invariant tests
├── lib/forge-std/                   # Foundry standard library (vendored)
├── scripts/                         # Arc Studio deploy / ABI helper scripts
├── src/
│   ├── App.tsx                      # Routes and error boundary
│   ├── config.ts                    # wagmi config (Arc + Arc Testnet)
│   ├── lib/vault.ts                 # Vault address, chain selection and ABI
│   ├── components/Layout.tsx        # App shell
│   └── pages/                       # Home, NewRun, RunDetail, MyRuns, Keepers
├── foundry.toml
├── vite.config.ts
└── package.json
```

### Tech stack

React 18 · Vite · TypeScript · Tailwind CSS · wagmi v2 · viem v2 · ConnectKit · Solidity 0.8.28 · Foundry · OpenZeppelin Contracts 5

## License

[MIT](LICENSE) © KutluhanETH
