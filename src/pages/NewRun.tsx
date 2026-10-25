import { useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useAccount, useWriteContract, useSwitchChain, useReadContract,
} from 'wagmi'
import {
  erc20Abi, isAddress, parseUnits, parseEventLogs,
  stringToHex, createPublicClient, http,
} from 'viem'
import { Plus, Trash2, Loader2, ExternalLink, AlertCircle, Info } from 'lucide-react'
import { toast } from 'sonner'
import {
  VAULT, VAULT_DEPLOYED, TARGET_CHAIN_ID, USDC, CHAIN,
  formatUsdc, explorerTx,
} from '@/lib/vault'
import { decodeVaultError } from '@/lib/errors'

const glass = {
  card: {
    background: 'var(--surface-strong)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    border: '1px solid var(--border)',
    borderRadius: '1.5rem',
  } as React.CSSProperties,
  inner: {
    background: 'var(--surface-muted)',
    border: '1px solid var(--border)',
    borderRadius: '1rem',
  } as React.CSSProperties,
}

const MAX_LINES        = 50
const MAX_RUN_TOTAL    = 500_000_000n   // 500 USDC in 6-decimal units
const MAX_TIP          = 1_000_000n     // 1 USDC
const MAX_HORIZON_DAYS = 730
const USDC_DECIMALS    = 6

// User's local timezone abbreviation for display
const TZ_LABEL = (() => {
  try {
    return new Intl.DateTimeFormat('en', { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find(p => p.type === 'timeZoneName')?.value ?? ''
  } catch { return '' }
})()

interface LineRow {
  id: string     // stable key — use crypto.randomUUID or counter
  recipient: string
  amount: string
  tip: string
  dueDate: string   // YYYY-MM-DD
  dueTime: string   // HH:mm
  label: string     // UTF-8, max 32 bytes
}

/** Format a Date as YYYY-MM-DD in local timezone. */
function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Format a Date as HH:mm in local timezone. */
function localTimeStr(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

let _rowId = 0
function makeRow(): LineRow {
  // Default to 24 hours from now, rounded up to the next 5-minute mark, in local timezone
  const soon = new Date(Date.now() + 86_400_000)
  soon.setMinutes(Math.ceil(soon.getMinutes() / 5) * 5, 0, 0)
  return {
    id: String(++_rowId),
    recipient: '',
    amount: '',
    tip: '0',
    dueDate: localDateStr(soon),
    dueTime: localTimeStr(soon),
    label: '',
  }
}

/** Parse a user decimal string to a bigint with the given decimals. Returns null on bad input. */
function parseBigDecimal(s: string, decimals: number): bigint | null {
  if (!s || !/^\d*\.?\d*$/.test(s)) return null
  const [int = '0', frac = ''] = s.split('.')
  if (frac.length > decimals) return null   // too many decimal places
  const padded = frac.padEnd(decimals, '0')
  try { return parseUnits(`${int}.${frac}`, decimals) } catch { return BigInt(int + padded) }
}

/** Encode a UTF-8 string to bytes32, returning null if it exceeds 32 bytes. */
function encodeRef(s: string): `0x${string}` | null {
  if (!s) return `0x${'00'.repeat(32)}`
  const encoded = new TextEncoder().encode(s)
  if (encoded.length > 32) return null
  return stringToHex(s, { size: 32 })
}

function rowDueSec(row: LineRow): number {
  // Parse date+time as LOCAL timezone by splitting components manually.
  // new Date('YYYY-MM-DDTHH:mm:ss') is parsed as UTC in strict ISO-8601 mode;
  // using explicit year/month/day/hour/minute avoids that ambiguity.
  const [y, mo, d] = row.dueDate.split('-').map(Number)
  const [h, mi]    = row.dueTime.split(':').map(Number)
  return Math.floor(new Date(y, mo - 1, d, h, mi, 0).getTime() / 1000)
}

function validateRow(row: LineRow, payer: string): string | null {
  if (!isAddress(row.recipient)) return 'Invalid address.'
  if (row.recipient === '0x0000000000000000000000000000000000000000') return 'Zero address not allowed.'
  if (row.recipient.toLowerCase() === payer.toLowerCase()) return 'Cannot pay yourself.'
  if (row.recipient.toLowerCase() === VAULT.address.toLowerCase()) return 'Vault cannot be a recipient.'
  if (row.recipient.toLowerCase() === USDC.address.toLowerCase()) return 'USDC token address cannot be a recipient.'

  const amt = parseBigDecimal(row.amount, USDC_DECIMALS)
  if (amt === null) return 'Invalid amount (max 6 decimal places).'
  if (amt === 0n) return 'Amount must be greater than zero.'

  const tip = parseBigDecimal(row.tip, USDC_DECIMALS)
  if (tip === null) return 'Invalid tip (max 6 decimal places).'
  if (tip > MAX_TIP) return 'Tip exceeds 1 USDC maximum.'

  const due = rowDueSec(row)
  const nowSec = Math.floor(Date.now() / 1000)
  if (due <= nowSec) return 'Due date must be in the future.'
  if (due > nowSec + MAX_HORIZON_DAYS * 86400) return `Due date must be within ${MAX_HORIZON_DAYS} days.`
  return null
}

type TxStep = 'idle' | 'approve-pending' | 'approve-confirming' | 'create-pending' | 'create-confirming' | 'done'

// Shared public client for receipt polling
function makeClient() {
  return createPublicClient({ transport: http(CHAIN.rpcUrls[0]) })
}

export default function NewRun() {
  const navigate = useNavigate()
  const { address, isConnected, chainId } = useAccount()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const { writeContractAsync: approveWrite } = useWriteContract()
  const { writeContractAsync: createWrite } = useWriteContract()

  const [rows, setRows]           = useState<LineRow[]>([makeRow()])
  const [committed, setCommitted] = useState(false)
  const [runRef, setRunRef]       = useState('')
  const [runRefErr, setRunRefErr] = useState('')
  const [step, setStep]           = useState<TxStep>('idle')
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | undefined>()
  const [createTxHash, setCreateTxHash] = useState<`0x${string}` | undefined>()
  const [newRunId, setNewRunId]   = useState<bigint | undefined>()
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  const wrongChain = isConnected && chainId !== TARGET_CHAIN_ID

  // Parse totals as bigints
  const { totalAmount, totalTip, totalLock, overLimit } = useMemo(() => {
    let ta = 0n, tt = 0n
    for (const r of rows) {
      ta += parseBigDecimal(r.amount, USDC_DECIMALS) ?? 0n
      tt += parseBigDecimal(r.tip, USDC_DECIMALS) ?? 0n
    }
    const tl = ta + tt
    return { totalAmount: ta, totalTip: tt, totalLock: tl, overLimit: tl > MAX_RUN_TOTAL }
  }, [rows])

  // USDC balance
  const { data: usdcBalance } = useReadContract({
    address: USDC.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!address },
  })

  // Current allowance
  const { data: currentAllowance, refetch: refetchAllowance } = useReadContract({
    address: USDC.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [
      address ?? '0x0000000000000000000000000000000000000000',
      VAULT.address,
    ],
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!address },
  })

  const belowBalance = usdcBalance !== undefined && totalLock > usdcBalance

  const addRow = useCallback(() => {
    if (rows.length >= MAX_LINES) return
    setRows(r => [...r, makeRow()])
  }, [rows.length])

  const removeRow = useCallback((id: string) => {
    setRows(r => r.filter(row => row.id !== id))
    setRowErrors(e => { const n = { ...e }; delete n[id]; return n })
  }, [])

  const updateRow = useCallback((id: string, field: keyof LineRow, value: string) => {
    setRows(r => r.map(row => row.id === id ? { ...row, [field]: value } : row))
    setRowErrors(e => { const n = { ...e }; delete n[id]; return n })
  }, [])

  async function handleSubmit() {
    if (!address) return

    // Validate run ref
    const refHex = encodeRef(runRef)
    if (refHex === null) { setRunRefErr('Run reference exceeds 32 bytes.'); return }
    setRunRefErr('')

    // Validate all rows
    const newErrors: Record<string, string> = {}
    for (const row of rows) {
      const err = validateRow(row, address)
      if (err) newErrors[row.id] = err
    }
    if (Object.keys(newErrors).length) { setRowErrors(newErrors); return }
    if (overLimit || belowBalance) return

    try {
      const client = makeClient()

      // Step 1: approve (skip if allowance already covers totalLock)
      const needsApprove = (currentAllowance ?? 0n) < totalLock
      if (needsApprove) {
        setStep('approve-pending')
        const approveTx = await approveWrite({
          address: USDC.address as `0x${string}`,
          abi: erc20Abi,
          functionName: 'approve',
          args: [VAULT.address, totalLock],
          chainId: TARGET_CHAIN_ID,
        })
        setApproveTxHash(approveTx)
        setStep('approve-confirming')
        const approveReceipt = await client.waitForTransactionReceipt({ hash: approveTx })
        if (approveReceipt.status !== 'success') throw new Error('USDC approval transaction failed.')
        toast.success('USDC approved.', {
          action: { label: 'Explorer', onClick: () => window.open(explorerTx(approveTx), '_blank') },
        })
        await refetchAllowance()
      }

      // Step 2: createRun
      setStep('create-pending')
      const lineInputs = rows.map(row => ({
        recipient: row.recipient as `0x${string}`,
        amount:    parseBigDecimal(row.amount, USDC_DECIMALS) ?? 0n,
        tip:       parseBigDecimal(row.tip, USDC_DECIMALS) ?? 0n,
        dueAt:     BigInt(rowDueSec(row)),
        lineRef:   encodeRef(row.label) ?? `0x${'00'.repeat(32)}`,
      }))

      const createTx = await createWrite({
        address: VAULT.address,
        abi: VAULT.abi,
        functionName: 'createRun',
        args: [lineInputs, committed, refHex],
        chainId: TARGET_CHAIN_ID,
      })
      setCreateTxHash(createTx)
      setStep('create-confirming')

      const receipt = await client.waitForTransactionReceipt({ hash: createTx })
      if (receipt.status !== 'success') throw new Error('createRun transaction failed on chain.')

      // Parse runId from RunCreated event (filter to vault address)
      const events = parseEventLogs({
        abi: VAULT.abi,
        logs: receipt.logs.filter(
          l => l.address.toLowerCase() === VAULT.address.toLowerCase()
        ),
        eventName: 'RunCreated',
      })
      const runId = events[0]?.args?.runId
      if (runId !== undefined) setNewRunId(runId)

      setStep('done')
      toast.success('Run created!', {
        action: { label: 'Explorer', onClick: () => window.open(explorerTx(createTx), '_blank') },
      })
    } catch (err) {
      setStep('idle')
      const msg = decodeVaultError(err)
      if (!msg.includes('cancelled')) toast.error(msg)
    }
  }

  const isSubmitting = step === 'approve-pending' || step === 'approve-confirming'
    || step === 'create-pending' || step === 'create-confirming'

  // Not-deployed guard
  if (!VAULT_DEPLOYED) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          PayrunVault is not deployed on {CHAIN.name} yet.
        </p>
      </div>
    )
  }

  if (!isConnected) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Connect your wallet to create a payrun.</p>
      </div>
    )
  }

  if (step === 'done') {
    return (
      <div className="mx-auto max-w-lg px-4 py-10">
        <div className="p-6 text-center" style={glass.card}>
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl"
            style={{ background: 'rgba(141, 216, 159, 0.15)' }}>
            <span className="text-2xl" style={{ color: 'var(--success)' }}>✓</span>
          </div>
          <h2 className="display mb-1 text-2xl font-bold" style={{ color: 'var(--ink)' }}>Run created!</h2>
          {newRunId !== undefined && (
            <p className="mb-4 text-sm" style={{ color: 'var(--muted)' }}>Run #{newRunId.toString()}</p>
          )}
          <div className="flex flex-col gap-2">
            {approveTxHash && (
              <a
                href={explorerTx(approveTxHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-1 text-xs font-medium transition-opacity hover:opacity-70"
                style={{ color: 'var(--muted)' }}
              >
                Approve tx <ExternalLink className="size-3" />
              </a>
            )}
            {createTxHash && (
              <a
                href={explorerTx(createTxHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-1 text-xs font-medium transition-opacity hover:opacity-70"
                style={{ color: 'var(--accent)' }}
              >
                Create tx <ExternalLink className="size-3" />
              </a>
            )}
            {newRunId !== undefined && (
              <button
                onClick={() => { void navigate(`/run/${newRunId.toString()}`) }}
                className="mt-2 w-full rounded-2xl py-3 text-sm font-semibold transition-all hover:scale-[1.01]"
                style={{ background: 'var(--accent)', color: 'var(--bg)' }}
              >
                View run details
              </button>
            )}
            <button
              onClick={() => { setStep('idle'); setRows([makeRow()]); setRunRef(''); setNewRunId(undefined); setApproveTxHash(undefined) }}
              className="w-full rounded-2xl py-2.5 text-sm font-medium transition-opacity hover:opacity-70"
              style={{ color: 'var(--muted)' }}
            >
              Create another run
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="display mb-6 text-2xl font-bold" style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}>
        New Payrun
      </h1>

      {/* Lines table */}
      <div className="mb-4 overflow-hidden" style={glass.card}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Recipient', 'Amount (USDC)', 'Tip (USDC)', `Due date & time (${TZ_LABEL})`, 'Label', ''].map((h, hi) => (
                  <th key={hi} className="px-3 py-2.5 text-left font-semibold" style={{ color: 'var(--subtle)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                // Fragment with explicit key — no wrapper element needed
                <tr key={`data-${row.id}`} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td colSpan={6} className="p-0">
                    {/* Two-row layout inside a single td to avoid Fragment key issues */}
                    <table className="w-full">
                      <tbody>
                        <tr>
                          <td className="px-3 py-2">
                            <input
                              value={row.recipient}
                              onChange={e => updateRow(row.id, 'recipient', e.target.value)}
                              placeholder="0x…"
                              className="mono w-40 rounded-lg bg-transparent px-2 py-1.5 text-xs outline-none placeholder:opacity-40"
                              style={{ border: '1px solid var(--border)', color: 'var(--ink)' }}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              inputMode="decimal"
                              value={row.amount}
                              onChange={e => {
                                const v = e.target.value.replace(/[^0-9.]/g, '')
                                if (v === '' || /^\d*\.?\d{0,6}$/.test(v)) updateRow(row.id, 'amount', v)
                              }}
                              placeholder="10.00"
                              className="w-24 rounded-lg bg-transparent px-2 py-1.5 text-xs tabular-nums outline-none placeholder:opacity-40"
                              style={{ border: '1px solid var(--border)', color: 'var(--ink)' }}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              inputMode="decimal"
                              value={row.tip}
                              onChange={e => {
                                const v = e.target.value.replace(/[^0-9.]/g, '')
                                if (v === '' || /^\d*\.?\d{0,6}$/.test(v)) updateRow(row.id, 'tip', v)
                              }}
                              placeholder="0.10"
                              className="w-20 rounded-lg bg-transparent px-2 py-1.5 text-xs tabular-nums outline-none placeholder:opacity-40"
                              style={{ border: '1px solid var(--border)', color: 'var(--ink)' }}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1">
                              <input
                                type="date"
                                value={row.dueDate}
                                onChange={e => updateRow(row.id, 'dueDate', e.target.value)}
                                className="rounded-lg bg-transparent px-2 py-1.5 text-xs outline-none"
                                style={{ border: '1px solid var(--border)', color: 'var(--ink)' }}
                              />
                              <input
                                type="time"
                                value={row.dueTime}
                                onChange={e => updateRow(row.id, 'dueTime', e.target.value)}
                                className="w-20 rounded-lg bg-transparent px-2 py-1.5 text-xs outline-none"
                                style={{ border: '1px solid var(--border)', color: 'var(--ink)' }}
                              />
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <input
                              value={row.label}
                              onChange={e => {
                                const v = e.target.value
                                // Block if UTF-8 byte count > 32
                                if (new TextEncoder().encode(v).length <= 32) updateRow(row.id, 'label', v)
                              }}
                              placeholder="Optional"
                              className="w-28 rounded-lg bg-transparent px-2 py-1.5 text-xs outline-none placeholder:opacity-40"
                              style={{ border: '1px solid var(--border)', color: 'var(--ink)' }}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <button
                              onClick={() => removeRow(row.id)}
                              disabled={rows.length === 1}
                              className="rounded-lg p-1.5 transition-opacity hover:opacity-70 disabled:opacity-20"
                            >
                              <Trash2 className="size-3.5" style={{ color: 'var(--danger)' }} />
                            </button>
                          </td>
                        </tr>
                        {rowErrors[row.id] && (
                          <tr key={`err-${row.id}`}>
                            <td colSpan={6} className="px-3 pb-2 pt-0">
                              <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--danger)' }}>
                                <AlertCircle className="size-3" /> {rowErrors[row.id]}
                              </span>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length < MAX_LINES && (
          <div className="px-3 pb-3 pt-1">
            <button
              onClick={addRow}
              className="flex items-center gap-1 text-xs font-medium transition-opacity hover:opacity-70"
              style={{ color: 'var(--accent)' }}
            >
              <Plus className="size-3.5" /> Add line
            </button>
          </div>
        )}
      </div>

      {/* Options row */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Committed toggle */}
        <div className="flex items-center justify-between p-4" style={glass.card}>
          <div className="mr-3">
            <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              Committed (cannot be cancelled)
            </p>
            <p className="mt-0.5 text-xs" style={{ color: committed ? 'var(--danger)' : 'var(--muted)' }}>
              {committed
                ? 'Warning: once created, lines in this run cannot be cancelled.'
                : 'Payer can cancel lines before they are due.'}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={committed}
            onClick={() => setCommitted(c => !c)}
            className="relative h-6 w-11 shrink-0 rounded-full transition-colors"
            style={{ background: committed ? 'var(--danger)' : 'var(--border-strong)' }}
          >
            <span
              className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform"
              style={{ left: committed ? '1.375rem' : '0.125rem' }}
            />
          </button>
        </div>

        {/* Run reference */}
        <div className="p-4" style={glass.card}>
          <label className="mb-1.5 block text-sm font-semibold" style={{ color: 'var(--ink)' }}>
            Run reference
            <span className="ml-1 text-xs font-normal" style={{ color: 'var(--subtle)' }}>
              ({new TextEncoder().encode(runRef).length}/32 bytes)
            </span>
          </label>
          <input
            value={runRef}
            onChange={e => {
              const v = e.target.value
              if (new TextEncoder().encode(v).length <= 32) { setRunRef(v); setRunRefErr('') }
              else setRunRefErr('Exceeds 32 bytes.')
            }}
            placeholder="e.g. Oct payroll"
            className="w-full rounded-xl px-3 py-2 text-sm outline-none placeholder:opacity-40"
            style={{ ...glass.inner, color: 'var(--ink)' }}
          />
          {runRefErr && <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>{runRefErr}</p>}
        </div>
      </div>

      {/* Summary */}
      <div className="mb-4 p-4" style={glass.card}>
        <div className="flex items-center justify-between text-sm">
          <span style={{ color: 'var(--muted)' }}>Lines</span>
          <span className="tabular-nums font-semibold" style={{ color: 'var(--ink)' }}>{rows.length} / {MAX_LINES}</span>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-sm">
          <span style={{ color: 'var(--muted)' }}>Total amounts</span>
          <span className="tabular-nums font-semibold" style={{ color: 'var(--ink)' }}>{formatUsdc(totalAmount)} USDC</span>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-sm">
          <span style={{ color: 'var(--muted)' }}>Total tips</span>
          <span className="tabular-nums font-semibold" style={{ color: 'var(--ink)' }}>{formatUsdc(totalTip)} USDC</span>
        </div>
        <div
          className="mt-2 flex items-center justify-between border-t pt-2 text-sm font-bold"
          style={{ borderColor: 'var(--border)', color: overLimit ? 'var(--danger)' : 'var(--ink)' }}
        >
          <span>Total to lock</span>
          <span className="tabular-nums">
            {formatUsdc(totalLock)} / 500.00 USDC
            {overLimit && ' — exceeds limit'}
          </span>
        </div>
        {usdcBalance !== undefined && (
          <p className="mt-1 text-right text-xs" style={{ color: belowBalance ? 'var(--danger)' : 'var(--subtle)' }}>
            Your balance: {formatUsdc(usdcBalance)} USDC
            {belowBalance && ' — insufficient'}
          </p>
        )}
        {currentAllowance !== undefined && currentAllowance >= totalLock && totalLock > 0n && (
          <p className="mt-1 flex items-center gap-1 text-xs" style={{ color: 'var(--success)' }}>
            <Info className="size-3" /> Allowance already covers this run — approve step will be skipped.
          </p>
        )}
      </div>

      {/* Step status */}
      {step !== 'idle' && (
        <div
          className="mb-4 flex items-center gap-2 rounded-2xl p-4 text-sm"
          style={{ ...glass.inner, color: 'var(--ink)' }}
        >
          <Loader2 className="size-4 animate-spin shrink-0" style={{ color: 'var(--accent)' }} />
          {step === 'approve-pending'    && 'Waiting for USDC approval in wallet…'}
          {step === 'approve-confirming' && 'Confirming USDC approval…'}
          {step === 'create-pending'     && 'Confirm the payrun in wallet…'}
          {step === 'create-confirming'  && 'Confirming payrun on chain…'}
        </div>
      )}

      {/* Submit */}
      <button
        onClick={wrongChain
          ? () => switchChain({ chainId: TARGET_CHAIN_ID })
          : () => { void handleSubmit() }}
        disabled={isSubmitting || (!wrongChain && (overLimit || belowBalance))}
        className="w-full rounded-2xl py-3.5 text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        style={{ background: 'var(--accent)', color: 'var(--bg)' }}
      >
        {isSwitching ? (
          <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Switching…</span>
        ) : wrongChain ? (
          `Switch to ${CHAIN.name}`
        ) : isSubmitting ? (
          <span className="flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Processing…</span>
        ) : (
          `Approve & Create Run — ${formatUsdc(totalLock)} USDC`
        )}
      </button>
    </div>
  )
}
