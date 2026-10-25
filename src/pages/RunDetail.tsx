import { useParams } from 'react-router-dom'
import { useAccount, useReadContract, useWriteContract, useSwitchChain, usePublicClient } from 'wagmi'
import { useState, useEffect, useCallback } from 'react'
import { hexToString, parseEventLogs } from 'viem'
import { ConnectKitButton } from 'connectkit'
import { Loader2, Clock, CheckCircle2, XCircle, Ban, RotateCcw, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import {
  VAULT, VAULT_DEPLOYED, TARGET_CHAIN_ID, CHAIN, formatUsdc, explorerAddr, explorerTx,
  statusLabel, type LineStatus,
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
}

function formatAddr(a: string) { return `${a.slice(0, 6)}…${a.slice(-4)}` }

/** Decode a bytes32 ref to a printable string, stripping null bytes. */
function decodeRef(hex: string): string {
  try { return hexToString(hex as `0x${string}`, { size: 32 }).replace(/\0/g, '').trim() } catch { return '' }
}

/** Format a Unix timestamp (seconds) as a local date+time string. */
function formatLocalDue(dueSec: number): string {
  return new Date(dueSec * 1000).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function statusIcon(s: LineStatus) {
  if (s === 'Paid')      return <CheckCircle2 className="size-4 shrink-0" style={{ color: 'var(--success)' }} />
  if (s === 'Declined')  return <XCircle      className="size-4 shrink-0" style={{ color: 'var(--danger)'  }} />
  if (s === 'Cancelled') return <Ban          className="size-4 shrink-0" style={{ color: 'var(--subtle)'  }} />
  if (s === 'Reclaimed') return <RotateCcw    className="size-4 shrink-0" style={{ color: 'var(--subtle)'  }} />
  return <Clock className="size-4 shrink-0" style={{ color: 'var(--muted)' }} />
}

/** Ticking countdown — re-renders every second while the line is still in the future. */
function Countdown({ dueAt }: { dueAt: bigint }) {
  const dueSec = Number(dueAt)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    if (now >= dueSec) return
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [dueSec, now])

  if (now >= dueSec) return <span style={{ color: 'var(--success)' }}>Due now</span>
  const diff = (dueSec - now) * 1000
  const d = Math.floor(diff / 86_400_000)
  const h = Math.floor((diff % 86_400_000) / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  const s = Math.floor((diff % 60_000) / 1000)
  return <span>{d > 0 ? `${d}d ` : ''}{h}h {m}m {d === 0 ? `${s}s` : ''}</span>
}

// ── Activity feed ────────────────────────────────────────────────────────────

type ActivityEntry = {
  key: string
  label: string
  detail: string      // amount or description
  timeMs: number      // block timestamp × 1000
  txHash: string
}

const ACTIVITY_EVENTS = [
  'RunCreated', 'LineReleased', 'LineCancelled', 'LineDeclined', 'LineReclaimed',
] as const

/** Decode one raw Blockscout log item into an ActivityEntry, or null if irrelevant. */
function decodeBlockscoutItem(
  item: { topics: string[]; data: string; block_timestamp: string; transaction_hash: string },
  runId: bigint,
): ActivityEntry | null {
  // item.topics[0] is the event selector; topics[1..] are indexed args
  const rawLog = {
    address:         VAULT.address,
    topics:          item.topics as [`0x${string}`, ...`0x${string}`[]],
    data:            item.data   as `0x${string}`,
    blockNumber:     0n,
    transactionHash: item.transaction_hash as `0x${string}`,
    blockHash:       '0x' as `0x${string}`,
    logIndex:        0,
    removed:         false,
    transactionIndex: 0,
  }
  for (const evName of ACTIVITY_EVENTS) {
    try {
      const decoded = parseEventLogs({ abi: VAULT.abi, logs: [rawLog], eventName: evName })
      if (!decoded.length) continue
      const ev = decoded[0]
      // Filter to this runId
      if ('runId' in ev.args && ev.args.runId !== runId) return null
      let label = '', detail = ''
      if (ev.eventName === 'RunCreated') {
        label  = 'Run created'
        detail = `${ev.args.lineCount} line${Number(ev.args.lineCount) !== 1 ? 's' : ''} · ${formatUsdc(ev.args.total)} USDC`
      } else if (ev.eventName === 'LineReleased') {
        label  = `Line ${ev.args.lineIndex} released`
        detail = `${formatUsdc(ev.args.amount)} USDC${ev.args.tip > 0n ? ` + ${formatUsdc(ev.args.tip)} tip` : ''}`
      } else if (ev.eventName === 'LineCancelled') {
        label  = `Line ${ev.args.lineIndex} cancelled`
        detail = `${formatUsdc(ev.args.amount)} USDC refunded`
      } else if (ev.eventName === 'LineDeclined') {
        label  = `Line ${ev.args.lineIndex} declined`
        detail = `${formatUsdc(ev.args.amount)} USDC refunded`
      } else if (ev.eventName === 'LineReclaimed') {
        label  = `Line ${ev.args.lineIndex} reclaimed`
        detail = `${formatUsdc(ev.args.amount)} USDC reclaimed`
      }
      if (!label) return null
      const timeMs = item.block_timestamp
        ? new Date(item.block_timestamp).getTime()
        : 0
      return { key: `${item.transaction_hash}-${evName}`, label, detail, timeMs, txHash: item.transaction_hash }
    } catch { /* not this event type */ }
  }
  return null
}

/** Decode one RPC log (with resolved block timestamp) into an ActivityEntry, or null. */
function decodeRpcLog(
  log: { topics: readonly `0x${string}`[]; data: `0x${string}`; transactionHash: `0x${string}` | null; blockNumber: bigint | null },
  timeMs: number,
  runId: bigint,
): ActivityEntry | null {
  const rawLog = {
    address:          VAULT.address,
    topics:           log.topics as [`0x${string}`, ...`0x${string}`[]],
    data:             log.data,
    blockNumber:      log.blockNumber ?? 0n,
    transactionHash:  log.transactionHash ?? '0x',
    blockHash:        '0x' as `0x${string}`,
    logIndex:         0,
    removed:          false,
    transactionIndex: 0,
  }
  for (const evName of ACTIVITY_EVENTS) {
    try {
      const decoded = parseEventLogs({ abi: VAULT.abi, logs: [rawLog], eventName: evName })
      if (!decoded.length) continue
      const ev = decoded[0]
      if ('runId' in ev.args && ev.args.runId !== runId) return null
      let label = '', detail = ''
      if (ev.eventName === 'RunCreated') {
        label  = 'Run created'
        detail = `${ev.args.lineCount} line${Number(ev.args.lineCount) !== 1 ? 's' : ''} · ${formatUsdc(ev.args.total)} USDC`
      } else if (ev.eventName === 'LineReleased') {
        label  = `Line ${ev.args.lineIndex} released`
        detail = `${formatUsdc(ev.args.amount)} USDC${ev.args.tip > 0n ? ` + ${formatUsdc(ev.args.tip)} tip` : ''}`
      } else if (ev.eventName === 'LineCancelled') {
        label  = `Line ${ev.args.lineIndex} cancelled`
        detail = `${formatUsdc(ev.args.amount)} USDC refunded`
      } else if (ev.eventName === 'LineDeclined') {
        label  = `Line ${ev.args.lineIndex} declined`
        detail = `${formatUsdc(ev.args.amount)} USDC refunded`
      } else if (ev.eventName === 'LineReclaimed') {
        label  = `Line ${ev.args.lineIndex} reclaimed`
        detail = `${formatUsdc(ev.args.amount)} USDC reclaimed`
      }
      if (!label) return null
      const txHash = log.transactionHash ?? ''
      return { key: `${txHash}-${evName}`, label, detail, timeMs, txHash }
    } catch { /* not this event type */ }
  }
  return null
}

type FeedState = 'loading' | 'ok' | 'unavailable'

function ActivityFeed({ runId, version }: { runId: bigint; version: number }) {
  const publicClient = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [entries,   setEntries]   = useState<ActivityEntry[]>([])
  const [feedState, setFeedState] = useState<FeedState>('loading')
  // (no separate `loading` boolean — feedState drives the render)

  useEffect(() => {
    let cancelled = false
    setFeedState('loading')

    void (async () => {
      // ── Primary: Blockscout REST API (allows CORS, no block-range limit) ────
      try {
        const base    = CHAIN.explorerBase
        const url     = `${base}/api/v2/addresses/${VAULT.address}/logs`
        const results: ActivityEntry[] = []
        let nextParams: string | null = null
        let page = 0
        const MAX_PAGES = 10

        while (page < MAX_PAGES) {
          const fetchUrl = nextParams ? `${url}?${nextParams}` : url
          const res = await fetch(fetchUrl, { headers: { Accept: 'application/json' } })
          if (!res.ok) throw new Error(`Blockscout HTTP ${res.status}`)
          const json = await res.json() as {
            items: Array<{ topics: string[]; data: string; block_timestamp: string; transaction_hash: string }>
            next_page_params: Record<string, string | number> | null
          }
          for (const item of json.items) {
            const entry = decodeBlockscoutItem(item, runId)
            if (entry) results.push(entry)
          }
          if (!json.next_page_params) break
          nextParams = new URLSearchParams(
            Object.entries(json.next_page_params).map(([k, v]) => [k, String(v)])
          ).toString()
          page++
        }

        if (cancelled) return
        results.sort((a, b) => b.timeMs - a.timeMs)
        setEntries(results)
        setFeedState('ok')
        return
      } catch (apiErr) {
        console.warn('[ActivityFeed] Blockscout API failed, trying RPC fallback', apiErr)
      }

      // ── Fallback: chunked RPC backwards from head ───────────────────────────
      if (!publicClient) { if (!cancelled) setFeedState('unavailable'); return }
      try {
        const latest   = await publicClient.getBlockNumber()
        const CHUNK    = 9_000n
        const MAX_BACK = 20

        // Build event topic0 set for the five activity events
        const eventAbis = ACTIVITY_EVENTS.map(evName =>
          VAULT.abi.find(
            (e): e is typeof e & { type: 'event'; name: typeof evName } =>
              e.type === 'event' && e.name === evName
          )!
        )

        const results: ActivityEntry[] = []
        let foundCreate = false

        for (let i = 0; i < MAX_BACK && !foundCreate; i++) {
          const toBlock   = latest - BigInt(i) * CHUNK
          const fromBlock = toBlock >= CHUNK ? toBlock - CHUNK + 1n : 0n
          if (toBlock < 0n) break

          const logSets = await Promise.all(
            eventAbis.map(ev =>
              publicClient.getLogs({
                address: VAULT.address,
                event: ev,
                args: { runId },
                fromBlock,
                toBlock,
              }).catch((): never[] => [])
            )
          )
          const blockNums = [...new Set(logSets.flat().map(l => l.blockNumber ?? 0n))]
          const blockTimes: Record<string, number> = {}
          await Promise.all(
            blockNums.map(async bn => {
              try {
                const blk = await publicClient.getBlock({ blockNumber: bn })
                blockTimes[bn.toString()] = Number(blk.timestamp) * 1000
              } catch { blockTimes[bn.toString()] = 0 }
            })
          )

          for (const log of logSets.flat()) {
            const timeMs = blockTimes[(log.blockNumber ?? 0n).toString()] ?? 0
            const entry = decodeRpcLog(log, timeMs, runId)
            if (entry) {
              results.push(entry)
              if (entry.label === 'Run created') foundCreate = true
            }
          }
        }

        if (cancelled) return
        results.sort((a, b) => b.timeMs - a.timeMs)
        setEntries(results)
        setFeedState('ok')
      } catch (rpcErr) {
        console.warn('[ActivityFeed] RPC fallback failed', rpcErr)
        if (!cancelled) setFeedState('unavailable')
      }
    })()

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, runId, version])

  if (feedState === 'loading') {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="size-4 animate-spin" style={{ color: 'var(--subtle)' }} />
      </div>
    )
  }

  if (feedState === 'unavailable') {
    return (
      <div className="mt-4 rounded-xl px-3 py-2.5 text-xs" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
        <span style={{ color: 'var(--muted)' }}>Activity unavailable — </span>
        <a
          href={`${CHAIN.explorerBase}/address/${VAULT.address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 transition-opacity hover:opacity-70"
          style={{ color: 'var(--accent)' }}
        >
          view vault on explorer <ExternalLink className="size-3" />
        </a>
      </div>
    )
  }

  if (!entries.length) return null

  return (
    <div className="mt-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--subtle)' }}>
        Activity
      </h2>
      <div className="flex flex-col gap-1.5">
        {entries.map(e => (
          <div
            key={e.key}
            className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-xs"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
          >
            <div className="min-w-0">
              <span className="font-semibold" style={{ color: 'var(--ink)' }}>{e.label}</span>
              {e.detail && (
                <span className="ml-1.5" style={{ color: 'var(--muted)' }}>{e.detail}</span>
              )}
              {e.timeMs > 0 && (
                <span className="ml-1.5 tabular-nums" style={{ color: 'var(--subtle)' }}>
                  · {new Date(e.timeMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
            {e.txHash && (
              <a
                href={explorerTx(e.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 transition-opacity hover:opacity-70"
                style={{ color: 'var(--accent)' }}
                title="View on explorer"
              >
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── LineCard ─────────────────────────────────────────────────────────────────

type VaultLine = { recipient: string; dueAt: bigint; status: number; amount: bigint; tip: bigint }
type VaultRun  = { payer: string; committed: boolean; createdAt: bigint; lineCount: number; ref: string }

function LineCard({
  runId, lineIndex, line, run, address, onAction,
}: {
  runId: bigint
  lineIndex: number
  line: VaultLine
  run: VaultRun
  address?: string
  onAction: () => void
}) {
  const { writeContractAsync } = useWriteContract()
  const [pending, setPending] = useState(false)
  const [lastTx, setLastTx] = useState<string>()
  const { switchChain } = useSwitchChain()
  const { chainId, isConnected } = useAccount()
  const publicClient = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const wrongChain = isConnected && chainId !== TARGET_CHAIN_ID

  const status  = statusLabel(line.status)
  // oxlint-disable-next-line react/purity -- Date.now() intentional for live due/stale checks
  const nowSec  = Math.floor(Date.now() / 1000)
  const isDue   = nowSec >= Number(line.dueAt)
  const isStale = nowSec >= Number(line.dueAt) + 30 * 86400
  const isPayer = !!address && address.toLowerCase() === run.payer.toLowerCase()
  const isRecipient = !!address && address.toLowerCase() === line.recipient.toLowerCase()

  const displayStatus = status === 'Pending' && isDue ? 'Due' : status

  const act = useCallback(async (fn: () => Promise<`0x${string}`>, label: string) => {
    if (!isConnected) return
    if (wrongChain) { switchChain({ chainId: TARGET_CHAIN_ID }); return }
    setPending(true)
    setLastTx(undefined)
    try {
      const hash = await fn()
      setLastTx(hash)
      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error(`${label} transaction failed on chain.`)
      }
      toast.success(`${label} confirmed.`, {
        action: { label: 'Explorer', onClick: () => window.open(explorerTx(hash), '_blank') },
      })
      onAction()
    } catch (err) {
      const msg = decodeVaultError(err)
      if (!msg.includes('cancelled')) toast.error(msg)
    } finally { setPending(false) }
  }, [isConnected, wrongChain, switchChain, publicClient, onAction])

  const canRelease  = status === 'Pending' && isDue
  const canDecline  = status === 'Pending' && isRecipient
  const canCancel   = status === 'Pending' && isPayer && !run.committed && !isDue
  const canReclaim  = status === 'Pending' && isPayer && isStale
  const hasActions  = canRelease || canDecline || canCancel || canReclaim

  return (
    <div
      className="flex items-start gap-3 rounded-2xl p-4"
      style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
    >
      <div className="mt-0.5">{statusIcon(status)}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <a
            href={explorerAddr(line.recipient)}
            target="_blank"
            rel="noopener noreferrer"
            className="mono text-xs font-medium hover:underline"
            style={{ color: 'var(--ink)' }}
          >
            {formatAddr(line.recipient)}
          </a>
          <span className="text-xs font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>
            {formatUsdc(line.amount)} USDC
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          <span>
            {displayStatus}
            {status === 'Pending' && (
              <>
                {' · '}
                <Countdown dueAt={line.dueAt} />
                {' · '}
                <span>{formatLocalDue(Number(line.dueAt))}</span>
              </>
            )}
          </span>
          {line.tip > 0n && <span className="tabular-nums">Tip: {formatUsdc(line.tip)}</span>}
        </div>

        {hasActions && (
          <div className="mt-2 flex flex-wrap gap-2">
            {canRelease && (
              <ActionBtn label="Release" disabled={pending} color="var(--success)"
                onClick={() => act(() => writeContractAsync({
                  address: VAULT.address, abi: VAULT.abi,
                  functionName: 'release', args: [runId, BigInt(lineIndex)],
                  chainId: TARGET_CHAIN_ID,
                }), 'Release')} />
            )}
            {canDecline && (
              <ActionBtn label="Decline" disabled={pending} color="var(--danger)"
                onClick={() => act(() => writeContractAsync({
                  address: VAULT.address, abi: VAULT.abi,
                  functionName: 'decline', args: [runId, BigInt(lineIndex)],
                  chainId: TARGET_CHAIN_ID,
                }), 'Decline')} />
            )}
            {canCancel && (
              <ActionBtn label="Cancel" disabled={pending} color="var(--subtle)"
                onClick={() => act(() => writeContractAsync({
                  address: VAULT.address, abi: VAULT.abi,
                  functionName: 'cancel', args: [runId, [BigInt(lineIndex)]],
                  chainId: TARGET_CHAIN_ID,
                }), 'Cancel')} />
            )}
            {canReclaim && (
              <ActionBtn label="Reclaim" disabled={pending} color="var(--muted)"
                onClick={() => act(() => writeContractAsync({
                  address: VAULT.address, abi: VAULT.abi,
                  functionName: 'reclaimStale', args: [runId, BigInt(lineIndex)],
                  chainId: TARGET_CHAIN_ID,
                }), 'Reclaim')} />
            )}
          </div>
        )}

        {lastTx && (
          <a
            href={explorerTx(lastTx)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 flex items-center gap-1 text-xs transition-opacity hover:opacity-70"
            style={{ color: 'var(--accent)' }}
          >
            View tx <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      {pending && <Loader2 className="mt-1 size-4 animate-spin shrink-0" style={{ color: 'var(--accent)' }} />}
    </div>
  )
}

function ActionBtn({ label, disabled, color, onClick }: {
  label: string; disabled: boolean; color: string; onClick: () => unknown
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg px-2.5 py-1 text-xs font-semibold transition-opacity hover:opacity-80 disabled:opacity-40"
      style={{ background: `${color}22`, color }}
    >
      {label}
    </button>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function RunDetail() {
  const { id } = useParams<{ id: string }>()
  const { address, isConnected, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const publicClient = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const wrongChain = isConnected && chainId !== TARGET_CHAIN_ID

  const isValidId = !!id && /^\d+$/.test(id) && id !== '0'
  const runId = isValidId ? BigInt(id) : undefined

  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion(v => v + 1), [])

  const { data: run, isLoading: runLoading, error: runError, refetch: refetchRun } = useReadContract({
    address: VAULT.address, abi: VAULT.abi,
    functionName: 'getRun', args: [runId ?? 0n],
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!runId && VAULT_DEPLOYED },
  })

  const { data: lines, isLoading: linesLoading, refetch: refetchLines } = useReadContract({
    address: VAULT.address, abi: VAULT.abi,
    functionName: 'getLines', args: [runId ?? 0n],
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!runId && !!run && VAULT_DEPLOYED },
  })

  const handleAction = useCallback(() => {
    void refetchRun()
    void refetchLines()
    reload()
  }, [refetchRun, refetchLines, reload])

  const { writeContractAsync: releaseManyWrite } = useWriteContract()
  const [releasingAll, setReleasingAll] = useState(false)
  const [releaseTx, setReleaseTx] = useState<string>()

  async function releaseAll() {
    if (!runId || !lines) return
    if (!isConnected) return
    if (wrongChain) { switchChain({ chainId: TARGET_CHAIN_ID }); return }
    const releaseNow = Math.floor(Date.now() / 1000)
    const dueIdx = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.status === 0 && releaseNow >= Number(l.dueAt))
      .map(({ i }) => BigInt(i))
    if (!dueIdx.length) { toast.info('No due lines to release.'); return }
    setReleasingAll(true)
    setReleaseTx(undefined)
    try {
      const hash = await releaseManyWrite({
        address: VAULT.address, abi: VAULT.abi,
        functionName: 'releaseMany', args: [runId, dueIdx],
        chainId: TARGET_CHAIN_ID,
      })
      setReleaseTx(hash)
      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('releaseMany transaction failed on chain.')
      }
      toast.success('Lines released.', {
        action: { label: 'Explorer', onClick: () => window.open(explorerTx(hash), '_blank') },
      })
      handleAction()
    } catch (err) {
      toast.error(decodeVaultError(err))
    } finally { setReleasingAll(false) }
  }

  // ── render guards ────────────────────────────────────────────────────────────

  if (!VAULT_DEPLOYED) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-sm" style={{ color: 'var(--danger)' }}>PayrunVault is not deployed on this network.</p>
      </div>
    )
  }

  if (!isValidId) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center text-sm" style={{ color: 'var(--muted)' }}>
        Invalid run ID.
      </div>
    )
  }

  if (runLoading) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <Loader2 className="mx-auto size-6 animate-spin" style={{ color: 'var(--accent)' }} />
      </div>
    )
  }

  const runErrMsg = runError?.message ?? ''
  const isNotFound = !!runError && (
    runErrMsg.includes('RunNotFound') || runErrMsg.toLowerCase().includes('not found')
  )
  if (isNotFound || (!run && !runLoading)) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center text-sm" style={{ color: 'var(--danger)' }}>
        Run #{id} not found.
      </div>
    )
  }
  if (runError) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center text-sm" style={{ color: 'var(--danger)' }}>
        RPC error loading run #{id}. {runErrMsg}
      </div>
    )
  }
  if (!run) return null

  // oxlint-disable-next-line react/purity -- Date.now() intentional for due-count display
  const nowSec   = Math.floor(Date.now() / 1000)
  const isPayer  = !!address && address.toLowerCase() === run.payer.toLowerCase()
  const dueCount = lines?.filter(l => l.status === 0 && nowSec >= Number(l.dueAt)).length ?? 0
  const refLabel = decodeRef(run.ref)

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      {/* Run header */}
      <div className="mb-4 p-5" style={glass.card}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="display text-2xl font-bold" style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}>
              Run #{id}
            </h1>
            {refLabel && (
              <p className="mt-0.5 text-sm font-medium" style={{ color: 'var(--ink-2)' }}>{refLabel}</p>
            )}
            <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
              Payer:{' '}
              <a href={explorerAddr(run.payer)} target="_blank" rel="noopener noreferrer"
                className="mono hover:underline">{formatAddr(run.payer)}</a>
              {isPayer && <span className="ml-1 text-xs font-semibold" style={{ color: 'var(--accent)' }}>(you)</span>}
            </p>
          </div>
          <span
            className="rounded-lg px-2.5 py-1 text-xs font-semibold"
            style={{
              background: run.committed ? 'rgba(232,109,122,0.12)' : 'rgba(141,216,159,0.12)',
              color: run.committed ? 'var(--danger)' : 'var(--success)',
            }}
          >
            {run.committed ? 'Committed' : 'Revocable'}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          <span>{run.lineCount} line{Number(run.lineCount) !== 1 ? 's' : ''}</span>
          <span className="text-right">Created {new Date(Number(run.createdAt) * 1000).toLocaleDateString()}</span>
        </div>

        {/* Release all */}
        {isConnected && dueCount > 0 && (
          <button
            onClick={() => { void releaseAll() }}
            disabled={releasingAll}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] disabled:opacity-50"
            style={{ background: 'var(--success)' }}
          >
            {releasingAll ? <Loader2 className="size-4 animate-spin" /> : null}
            Release all due ({dueCount})
          </button>
        )}
        {!isConnected && dueCount > 0 && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-xl p-3 text-xs"
            style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
            <span style={{ color: 'var(--muted)' }}>{dueCount} line{dueCount !== 1 ? 's' : ''} ready — connect to release</span>
            <ConnectKitButton />
          </div>
        )}
        {wrongChain && dueCount > 0 && (
          <button
            onClick={() => switchChain({ chainId: TARGET_CHAIN_ID })}
            className="mt-2 w-full rounded-xl py-2 text-xs font-semibold"
            style={{ background: 'var(--danger)', color: '#fff' }}
          >
            Switch network to release
          </button>
        )}
        {releaseTx && (
          <a
            href={explorerTx(releaseTx)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 flex items-center justify-center gap-1 text-xs transition-opacity hover:opacity-70"
            style={{ color: 'var(--accent)' }}
          >
            View release tx <ExternalLink className="size-3" />
          </a>
        )}
      </div>

      {/* Lines */}
      {linesLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin" style={{ color: 'var(--accent)' }} />
        </div>
      ) : lines?.length ? (
        <div className="flex flex-col gap-2">
          {lines.map((line, i) => (
            <LineCard
              key={i}
              runId={runId!}
              lineIndex={i}
              line={line}
              run={run as VaultRun}
              address={address}
              onAction={handleAction}
            />
          ))}
        </div>
      ) : (
        <p className="py-8 text-center text-sm" style={{ color: 'var(--muted)' }}>No lines found.</p>
      )}

      {/* Activity feed — refreshes on every action via version */}
      {runId !== undefined && <ActivityFeed runId={runId} version={version} />}
    </div>
  )
}
