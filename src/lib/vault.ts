/**
 * PayrunVault contract configuration.
 * Address from deployment; ABI from Foundry artifact.
 */
import { type Abi, isAddress } from 'viem'
import { requireChain, getUsdc } from '@/onchain-facts'

// ── Chain configuration ─────────────────────────────────────────────────────

// VITE_CHAIN=mainnet (default) | testnet
const chainEnv = (import.meta.env.VITE_CHAIN ?? 'mainnet') as 'testnet' | 'mainnet'
export const TARGET_CHAIN_ID: number = chainEnv === 'mainnet' ? 5042 : 5042002

export const CHAIN = requireChain(TARGET_CHAIN_ID)
export const USDC = getUsdc(TARGET_CHAIN_ID)!

// ── Vault address ────────────────────────────────────────────────────────────
// Use VITE_VAULT_ADDRESS_TESTNET / VITE_VAULT_ADDRESS_MAINNET for per-chain config.
// Falls back to the known testnet deployment for convenience.

const ZERO = '0x0000000000000000000000000000000000000000' as const

/** Normalise a raw env-var value: keep valid hex addresses, fall back to zero. */
function normaliseAddr(raw: string | undefined, fallback: `0x${string}`): `0x${string}` {
  if (!raw || raw.trim() === '') return fallback
  const trimmed = raw.trim()
  return isAddress(trimmed) ? (trimmed.toLowerCase() as `0x${string}`) : ZERO
}

const VAULT_ADDRESS_TESTNET = normaliseAddr(
  import.meta.env.VITE_VAULT_ADDRESS_TESTNET as string | undefined,
  '0x89e43c3f321b540713de4d6cfdd4076a8e277d11',
)

const VAULT_ADDRESS_MAINNET = normaliseAddr(
  import.meta.env.VITE_VAULT_ADDRESS_MAINNET as string | undefined,
  '0x77152ae071414d967313827587e477a7b6422896',
)

export const VAULT_ADDRESS: `0x${string}` =
  chainEnv === 'mainnet' ? VAULT_ADDRESS_MAINNET : VAULT_ADDRESS_TESTNET

/** True when the vault has a valid, non-zero address on the active chain. */
export const VAULT_DEPLOYED: boolean = VAULT_ADDRESS !== ZERO && isAddress(VAULT_ADDRESS)

// ── ABI ──────────────────────────────────────────────────────────────────────

export const VAULT_ABI = [
  // ── createRun ────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'createRun',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'lines',
        type: 'tuple[]',
        components: [
          { name: 'recipient', type: 'address' },
          { name: 'amount',    type: 'uint128' },
          { name: 'tip',       type: 'uint96'  },
          { name: 'dueAt',     type: 'uint64'  },
          { name: 'lineRef',   type: 'bytes32' },
        ],
      },
      { name: 'committed', type: 'bool'    },
      { name: 'ref',       type: 'bytes32' },
    ],
    outputs: [{ name: 'runId', type: 'uint256' }],
  },
  // ── release ──────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'release',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'runId', type: 'uint256' },
      { name: 'i',     type: 'uint256' },
    ],
    outputs: [],
  },
  // ── releaseMany ──────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'releaseMany',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'runId', type: 'uint256'   },
      { name: 'idx',   type: 'uint256[]' },
    ],
    outputs: [{ name: 'released', type: 'uint256' }],
  },
  // ── decline ──────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'decline',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'runId', type: 'uint256' },
      { name: 'i',     type: 'uint256' },
    ],
    outputs: [],
  },
  // ── cancel ───────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'cancel',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'runId', type: 'uint256'   },
      { name: 'idx',   type: 'uint256[]' },
    ],
    outputs: [],
  },
  // ── reclaimStale ─────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'reclaimStale',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'runId', type: 'uint256' },
      { name: 'i',     type: 'uint256' },
    ],
    outputs: [],
  },
  // ── views ─────────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'getRun',
    stateMutability: 'view',
    inputs: [{ name: 'runId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'payer',     type: 'address' },
          { name: 'committed', type: 'bool'    },
          { name: 'createdAt', type: 'uint64'  },
          { name: 'lineCount', type: 'uint32'  },
          { name: 'ref',       type: 'bytes32' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getLine',
    stateMutability: 'view',
    inputs: [
      { name: 'runId', type: 'uint256' },
      { name: 'i',     type: 'uint256' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'recipient', type: 'address' },
          { name: 'dueAt',     type: 'uint64'  },
          { name: 'status',    type: 'uint8'   },
          { name: 'amount',    type: 'uint128' },
          { name: 'tip',       type: 'uint96'  },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getLines',
    stateMutability: 'view',
    inputs: [{ name: 'runId', type: 'uint256' }],
    outputs: [
      {
        name: 'arr',
        type: 'tuple[]',
        components: [
          { name: 'recipient', type: 'address' },
          { name: 'dueAt',     type: 'uint64'  },
          { name: 'status',    type: 'uint8'   },
          { name: 'amount',    type: 'uint128' },
          { name: 'tip',       type: 'uint96'  },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'runsOfPayer',
    stateMutability: 'view',
    inputs: [
      { name: 'payer',  type: 'address' },
      { name: 'offset', type: 'uint256' },
      { name: 'limit',  type: 'uint256' },
    ],
    outputs: [{ name: 'page', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'runsOfPayerCount',
    stateMutability: 'view',
    inputs: [{ name: 'payer', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'linesOfRecipient',
    stateMutability: 'view',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'offset',    type: 'uint256' },
      { name: 'limit',     type: 'uint256' },
    ],
    outputs: [
      {
        name: 'page',
        type: 'tuple[]',
        components: [
          { name: 'runId',     type: 'uint256' },
          { name: 'lineIndex', type: 'uint256' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'linesOfRecipientCount',
    stateMutability: 'view',
    inputs: [{ name: 'recipient', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'runCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isDue',
    stateMutability: 'view',
    inputs: [
      { name: 'runId', type: 'uint256' },
      { name: 'i',     type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  // ── constants ─────────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'MAX_LINES',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'MAX_RUN_TOTAL',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'MAX_TIP',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'MAX_HORIZON',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'STALE_PERIOD',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  // ── events ────────────────────────────────────────────────────────────────
  {
    type: 'event',
    name: 'RunCreated',
    inputs: [
      { name: 'runId',     type: 'uint256', indexed: true  },
      { name: 'payer',     type: 'address', indexed: true  },
      { name: 'ref',       type: 'bytes32', indexed: false },
      { name: 'committed', type: 'bool',    indexed: false },
      { name: 'lineCount', type: 'uint32',  indexed: false },
      { name: 'total',     type: 'uint256', indexed: false },
      { name: 'tipTotal',  type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LineReleased',
    inputs: [
      { name: 'runId',     type: 'uint256', indexed: true  },
      { name: 'lineIndex', type: 'uint256', indexed: true  },
      { name: 'recipient', type: 'address', indexed: false },
      { name: 'amount',    type: 'uint128', indexed: false },
      { name: 'caller',    type: 'address', indexed: false },
      { name: 'tip',       type: 'uint96',  indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ReleaseSkipped',
    inputs: [
      { name: 'runId',     type: 'uint256', indexed: true  },
      { name: 'lineIndex', type: 'uint256', indexed: true  },
      { name: 'reason',    type: 'uint8',   indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LineDeclined',
    inputs: [
      { name: 'runId',     type: 'uint256', indexed: true  },
      { name: 'lineIndex', type: 'uint256', indexed: true  },
      { name: 'recipient', type: 'address', indexed: false },
      { name: 'amount',    type: 'uint128', indexed: false },
      { name: 'tip',       type: 'uint96',  indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LineCancelled',
    inputs: [
      { name: 'runId',     type: 'uint256', indexed: true  },
      { name: 'lineIndex', type: 'uint256', indexed: true  },
      { name: 'amount',    type: 'uint128', indexed: false },
      { name: 'tip',       type: 'uint96',  indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LineReclaimed',
    inputs: [
      { name: 'runId',     type: 'uint256', indexed: true  },
      { name: 'lineIndex', type: 'uint256', indexed: true  },
      { name: 'amount',    type: 'uint128', indexed: false },
      { name: 'tip',       type: 'uint96',  indexed: false },
    ],
  },
  // ── errors ────────────────────────────────────────────────────────────────
  { type: 'error', name: 'InvalidToken',             inputs: [] },
  { type: 'error', name: 'InvalidLineCount',         inputs: [] },
  { type: 'error', name: 'InvalidRecipient',         inputs: [] },
  { type: 'error', name: 'ZeroAmount',               inputs: [] },
  { type: 'error', name: 'TipTooHigh',               inputs: [] },
  { type: 'error', name: 'DueAtInvalid',             inputs: [] },
  { type: 'error', name: 'DueAtTooFar',              inputs: [] },
  { type: 'error', name: 'RunTotalExceeded',         inputs: [] },
  { type: 'error', name: 'BalanceInvariantViolated', inputs: [] },
  { type: 'error', name: 'NotPending',               inputs: [] },
  { type: 'error', name: 'NotDue',                   inputs: [] },
  { type: 'error', name: 'NotRecipient',             inputs: [] },
  { type: 'error', name: 'NotPayer',                 inputs: [] },
  { type: 'error', name: 'RunCommitted',             inputs: [] },
  { type: 'error', name: 'AlreadyDue',               inputs: [] },
  { type: 'error', name: 'NotStale',                 inputs: [] },
  { type: 'error', name: 'RunNotFound',              inputs: [] },
  { type: 'error', name: 'InvalidLineIndex',         inputs: [] },
  { type: 'error', name: 'OnlySelf',                 inputs: [] },
  { type: 'error', name: 'InsufficientGas',          inputs: [] },
] as const satisfies Abi

// ── Type helpers ─────────────────────────────────────────────────────────────

export type LineStatus = 'Pending' | 'Paid' | 'Declined' | 'Cancelled' | 'Reclaimed'

export function statusLabel(s: number): LineStatus {
  return (['Pending', 'Paid', 'Declined', 'Cancelled', 'Reclaimed'] as const)[s] ?? 'Pending'
}

export function skipReasonLabel(r: number): string {
  return (
    ['Line not pending', 'Not due yet', 'Invalid index', 'Transfer failed'] as const
  )[r] ?? 'Unknown'
}

export function formatUsdc(raw: bigint): string {
  const n = Number(raw) / 1e6
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
}

export function explorerTx(txHash: string): string {
  return `${CHAIN.explorerBase}/tx/${txHash}`
}

export function explorerAddr(addr: string): string {
  return `${CHAIN.explorerBase}/address/${addr}`
}

export const VAULT = {
  address: VAULT_ADDRESS,
  abi: VAULT_ABI,
  chainId: TARGET_CHAIN_ID,
} as const
