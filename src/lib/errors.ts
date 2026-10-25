/**
 * Custom error decoder for PayrunVault.
 * Uses viem's ContractFunctionRevertedError for precise selector matching.
 * Falls back to selector scanning for environments that surface raw data.
 */
import {
  ContractFunctionRevertedError,
  UserRejectedRequestError,
} from 'viem'

// Error-name → human message map (covers vault errors + OZ SafeERC20 / ReentrancyGuard)
const FRIENDLY: Record<string, string> = {
  InvalidToken:               'Invalid token address.',
  InvalidLineCount:           'A run must have 1 to 50 lines.',
  InvalidRecipient:           'One or more recipients are invalid (zero, self, vault, or token address).',
  ZeroAmount:                 'Line amount must be greater than zero.',
  TipTooHigh:                 'Tip exceeds the 1 USDC maximum.',
  DueAtInvalid:               'Due date must be in the future.',
  DueAtTooFar:                'Due date is more than 730 days away.',
  RunTotalExceeded:           'Total (amounts + tips) exceeds the 500 USDC run limit.',
  BalanceInvariantViolated:   'Token transfer did not match expected amount (fee-on-transfer token?).',
  NotPending:                 'This line is no longer pending.',
  NotDue:                     'This line is not due yet.',
  NotRecipient:               'Only the recipient can decline a line.',
  NotPayer:                   'Only the payer can perform this action.',
  RunCommitted:               'This run is committed and cannot be cancelled.',
  AlreadyDue:                 'This line is already past its due date and cannot be cancelled.',
  NotStale:                   'This line has not passed the 30-day stale period yet.',
  RunNotFound:                'Run not found.',
  InvalidLineIndex:           'Line index out of range.',
  OnlySelf:                   'This function can only be called by the vault itself.',
  InsufficientGas:            'Not enough gas to safely process all lines.',
  // OZ SafeERC20
  SafeERC20FailedOperation:   'USDC transfer failed (token rejected the operation).',
  // OZ ReentrancyGuard
  ReentrancyGuardReentrantCall: 'Reentrant call detected.',
  // Common ERC-20 errors
  ERC20InsufficientBalance:   'Insufficient USDC balance.',
  ERC20InsufficientAllowance: 'Insufficient USDC allowance.',
}

/** Walk an error chain and return the first match predicate returns true for. */
function walk<T>(err: unknown, pred: (e: unknown) => e is T): T | undefined {
  if (pred(err)) return err
  const cause = (err as { cause?: unknown } | null)?.cause
  if (cause !== undefined && cause !== err) return walk(cause, pred)
  return undefined
}

function isContractRevertedError(e: unknown): e is ContractFunctionRevertedError {
  return e instanceof ContractFunctionRevertedError
}

function isUserRejected(e: unknown): e is UserRejectedRequestError {
  return e instanceof UserRejectedRequestError
}

export function decodeVaultError(error: unknown): string {
  // 1. User rejection (walk first — it may be nested inside a ContractFunctionExecutionError)
  if (walk(error, isUserRejected)) return 'Transaction cancelled.'

  // 2. Structured contract revert via viem
  const revert = walk(error, isContractRevertedError)
  if (revert) {
    const name = revert.data?.errorName ?? ''
    if (name && FRIENDLY[name]) return FRIENDLY[name]
    // revert.reason is a human-readable string from require() if present
    if (revert.reason) return `Transaction reverted: ${revert.reason}`
    if (name) return `Transaction reverted: ${name}`
  }

  // 3. Scan raw message for known error names (wagmi sometimes surfaces them in message)
  const msg = (error as { message?: string })?.message ?? String(error)
  for (const [name, friendly] of Object.entries(FRIENDLY)) {
    if (msg.includes(name)) return friendly
  }

  // 4. Generic fallbacks
  const lower = msg.toLowerCase()
  if (lower.includes('user rejected') || lower.includes('rejected by user')) {
    return 'Transaction cancelled.'
  }
  if (lower.includes('insufficient funds') || lower.includes('exceeds balance')) {
    return 'Insufficient USDC balance or allowance.'
  }
  if (lower.includes('reverted')) {
    return 'Transaction reverted. Check your inputs and try again.'
  }

  return 'Something went wrong. Please try again.'
}
