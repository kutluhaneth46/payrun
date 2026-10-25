# Payrun

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

Payrun: scheduled multi-recipient USDC payroll vault on Arc.
Payers create runs that lock USDC; relayers earn tips by releasing due lines; recipients can decline (refunds payer); payers can cancel uncommitted lines before due date or reclaim stale lines after dueAt + 30 days.

## Contract Notes
- `contracts/PayrunVault.sol` — deployed with Arc USDC `0x3600000000000000000000000000000000000000`
- **Arc Mainnet deployment (chain 5042)**: `0x77152ae071414d967313827587e477a7b6422896`
  - Explorer: https://explorer.arc.io/address/0x77152ae071414d967313827587e477a7b6422896
  - Sourcify: https://sourcify.dev/server/v2/contract/5042/0x77152ae071414d967313827587e477a7b6422896
- **Arc Testnet deployment (chain 5042002)**: `0x89e43c3f321b540713de4d6cfdd4076a8e277d11`
  - Explorer: https://explorer.testnet.arc.io/address/0x89e43c3f321b540713de4d6cfdd4076a8e277d11
  - Tx: `0x2ce6f2ff7775820a58dac1dc243e91d6de3ef6b4042091279b1daf5ab3fb1599`
- Script: `contracts/script/DeployPayrunVault.s.sol`
- Tests: `contracts/test/PayrunVault.t.sol` (unit/fuzz), `contracts/test/PayrunVaultInvariant.t.sol` (invariant)
- 107 tests, all passing as of last run

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Mainnet (5042, default) or Arc Testnet (5042002) via `VITE_CHAIN`, both imported from `viem/chains`
- Token: USDC (6 decimals) at 0x3600000000000000000000000000000000000000 on both chains
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## To Run

```bash
bun install
bun run dev
```
