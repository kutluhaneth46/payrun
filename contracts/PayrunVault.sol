// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  PayrunVault
/// @notice Scheduled multi-recipient USDC payroll on Arc.
///         A payer creates a "run" containing one or more payment lines,
///         locking USDC in the vault.  Anyone can trigger release once a
///         line is due, earning the tip.  Recipients can decline (refund
///         to payer).  Payers can cancel uncommitted runs before due date
///         or reclaim stale lines after dueAt + STALE_PERIOD.
///
/// @dev    Run IDs start at 1.  Run 0 is the zero-value sentinel used to
///         detect non-existent runs (payer == address(0)).
contract PayrunVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────

    /// @notice Maximum lines per run.
    uint256 public constant MAX_LINES = 50;
    /// @notice Maximum total of amounts plus tips across all lines per run (500 USDC).
    ///         The sum of every line's amount and tip must not exceed this value.
    /// @dev    RunCreated.total is the sum of line amounts only; it does NOT include tips.
    uint256 public constant MAX_RUN_TOTAL = 500e6;
    /// @notice Maximum tip per line (1 USDC).
    uint256 public constant MAX_TIP = 1e6;
    /// @notice Maximum future offset for dueAt from block.timestamp at creation (730 days).
    uint256 public constant MAX_HORIZON = 730 days;
    /// @notice Minimum time after dueAt before the payer can reclaim a Pending line.
    uint256 public constant STALE_PERIOD = 30 days;

    /// @dev Gas floor required before attempting a line in releaseMany.
    ///      Sized generously to cover two safeTransfer calls plus overhead.
    uint256 private constant MIN_GAS_PER_LINE = 80_000;
    /// @dev Gas reserved after a failed line attempt: if gas remaining is below
    ///      this threshold the whole transaction reverts rather than reporting
    ///      TransferFailed (which would be a false report of transfer failure
    ///      caused by an out-of-gas condition).
    uint256 private constant GAS_RESERVE_AFTER_FAIL = 30_000;

    // ──────────────────────────────────────────────────
    // Immutables
    // ──────────────────────────────────────────────────

    /// @notice The USDC ERC-20 token used for all payments (6 decimals).
    IERC20 public immutable token;

    // ──────────────────────────────────────────────────
    // Types
    // ──────────────────────────────────────────────────

    enum Status { Pending, Paid, Declined, Cancelled, Reclaimed }

    struct Run {
        address payer;
        bool    committed;
        uint64  createdAt;
        uint32  lineCount;
        bytes32 ref;
    }

    struct Line {
        address recipient;
        uint64  dueAt;
        Status  status;
        uint128 amount;
        uint96  tip;
    }

    /// @notice Input shape for createRun.
    struct LineInput {
        address recipient;
        uint128 amount;
        uint96  tip;
        uint64  dueAt;
        bytes32 lineRef;
    }

    /// @notice Explicit (runId, lineIndex) pair returned by linesOfRecipient.
    struct LineRef {
        uint256 runId;
        uint256 lineIndex;
    }

    /// @notice Reason codes for ReleaseSkipped.
    enum SkipReason { NotPending, NotDue, InvalidIndex, TransferFailed }

    // ──────────────────────────────────────────────────
    // Storage
    // ──────────────────────────────────────────────────

    /// @notice Number of runs created.  Run IDs start at 1.
    uint256 public runCount;

    /// @dev Monotonically increasing ID cursor.  Starts at 1; runCount == _nextId - 1.
    uint256 private _nextId = 1;

    /// @dev runId → Run metadata.
    mapping(uint256 => Run) private _runs;

    /// @dev runId → line index → Line.
    mapping(uint256 => mapping(uint256 => Line)) private _lines;

    /// @dev payer → list of runIds (one entry per run, not per line).
    mapping(address => uint256[]) private _runsOfPayer;

    /// @dev recipient → list of LineRef pairs.
    mapping(address => LineRef[]) private _linesOfRecipient;

    // ──────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────

    /// @param total Sum of line amounts only (excluding tips).
    event RunCreated(
        uint256 indexed runId,
        address indexed payer,
        bytes32         ref,
        bool            committed,
        uint32          lineCount,
        uint256         total,
        uint256         tipTotal
    );

    event LineAdded(
        uint256 indexed runId,
        uint256 indexed lineIndex,
        address indexed recipient,
        uint128         amount,
        uint96          tip,
        uint64          dueAt,
        bytes32         lineRef
    );

    event LineReleased(
        uint256 indexed runId,
        uint256 indexed lineIndex,
        address         recipient,
        uint128         amount,
        address         caller,
        uint96          tip
    );

    /// @param reason Why the line was skipped (see SkipReason).
    event ReleaseSkipped(
        uint256 indexed runId,
        uint256 indexed lineIndex,
        uint8           reason
    );

    event LineDeclined(
        uint256 indexed runId,
        uint256 indexed lineIndex,
        address         recipient,
        uint128         amount,
        uint96          tip
    );

    event LineCancelled(
        uint256 indexed runId,
        uint256 indexed lineIndex,
        uint128         amount,
        uint96          tip
    );

    event LineReclaimed(
        uint256 indexed runId,
        uint256 indexed lineIndex,
        uint128         amount,
        uint96          tip
    );

    // ──────────────────────────────────────────────────
    // Custom errors
    // ──────────────────────────────────────────────────

    error InvalidToken();
    error InvalidLineCount();
    error InvalidRecipient();
    error ZeroAmount();
    error TipTooHigh();
    error DueAtInvalid();
    error DueAtTooFar();
    error RunTotalExceeded();
    error BalanceInvariantViolated();
    error NotPending();
    error NotDue();
    error NotRecipient();
    error NotPayer();
    error RunCommitted();
    error AlreadyDue();
    error NotStale();
    error RunNotFound();
    error InvalidLineIndex();
    error OnlySelf();
    error InsufficientGas();

    // ──────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────

    /// @param _token USDC ERC-20 address (6 decimals).
    ///               Must be a non-zero address with deployed code.
    constructor(address _token) {
        if (_token == address(0)) revert InvalidToken();
        if (_token.code.length == 0) revert InvalidToken();
        token = IERC20(_token);
    }

    // No receive() or fallback() — native value transfers are rejected.

    // ──────────────────────────────────────────────────
    // Core: createRun
    // ──────────────────────────────────────────────────

    /// @notice Lock USDC and create a payroll run.
    /// @param lines     Payment lines (1–50).
    /// @param committed If true, lines cannot be cancelled before dueAt.
    /// @param ref       Caller-defined reference label (stored, not interpreted).
    /// @return runId    The new run's identifier (starts at 1).
    function createRun(
        LineInput[] calldata lines,
        bool committed,
        bytes32 ref
    ) external nonReentrant returns (uint256 runId) {
        uint256 n = lines.length;
        if (n == 0 || n > MAX_LINES) revert InvalidLineCount();

        address payer = msg.sender;
        uint256 total;
        uint256 tipTotal;

        // ── validation pass ──────────────────────────
        for (uint256 i; i < n; ++i) {
            LineInput calldata l = lines[i];

            if (
                l.recipient == address(0) ||
                l.recipient == address(this) ||
                l.recipient == payer ||
                l.recipient == address(token)
            ) revert InvalidRecipient();

            if (l.amount == 0) revert ZeroAmount();
            if (l.tip > MAX_TIP) revert TipTooHigh();
            if (l.dueAt <= block.timestamp) revert DueAtInvalid();
            if (l.dueAt > block.timestamp + MAX_HORIZON) revert DueAtTooFar();

            // Overflow-safe: each amount ≤ MAX_RUN_TOTAL (500e6 < 2^128),
            // each tip ≤ MAX_TIP (1e6 < 2^96).  With MAX_LINES=50, the
            // maximum accumulated value is 50 * (500e6 + 1e6) < 2^256.
            total    += l.amount;
            tipTotal += l.tip;
        }

        if (total + tipTotal > MAX_RUN_TOTAL) revert RunTotalExceeded();

        // ── effects ──────────────────────────────────
        runId = _nextId++;
        runCount = _nextId - 1;

        _runs[runId] = Run({
            payer:     payer,
            committed: committed,
            createdAt: uint64(block.timestamp),
            lineCount: uint32(n),
            ref:       ref
        });

        // Push runId exactly once per run (not once per line).
        _runsOfPayer[payer].push(runId);

        for (uint256 i; i < n; ++i) {
            LineInput calldata l = lines[i];
            _lines[runId][i] = Line({
                recipient: l.recipient,
                dueAt:     l.dueAt,
                status:    Status.Pending,
                amount:    l.amount,
                tip:       l.tip
            });
            _linesOfRecipient[l.recipient].push(LineRef({ runId: runId, lineIndex: i }));
        }

        // ── interactions ─────────────────────────────
        uint256 lockAmount = total + tipTotal;
        uint256 balBefore  = token.balanceOf(address(this));
        token.safeTransferFrom(payer, address(this), lockAmount);
        if (token.balanceOf(address(this)) - balBefore != lockAmount) {
            revert BalanceInvariantViolated();
        }

        emit RunCreated(runId, payer, ref, committed, uint32(n), total, tipTotal);

        for (uint256 i; i < n; ++i) {
            LineInput calldata l = lines[i];
            emit LineAdded(runId, i, l.recipient, l.amount, l.tip, l.dueAt, l.lineRef);
        }
    }

    // ──────────────────────────────────────────────────
    // Core: release
    // ──────────────────────────────────────────────────

    /// @notice Release a single due Pending line.
    ///         Amount goes to the recipient; tip goes to msg.sender.
    function release(uint256 runId, uint256 i) external nonReentrant {
        _checkRunAndLine(runId, i);
        _release(runId, i, msg.sender);
    }

    /// @notice Release many lines atomically per line.
    ///         Each line is attempted via an internal self-call so that a
    ///         transfer failure (e.g. blocklisted recipient) reverts only
    ///         that line and leaves it Pending.  Invalid indices, not-due
    ///         lines and already-settled lines are skipped with a reason code.
    ///         Out-of-gas is distinguished from a real transfer failure: if
    ///         gasleft() is below MIN_GAS_PER_LINE before an attempt the
    ///         whole transaction reverts; after a failed attempt the tx also
    ///         reverts if remaining gas would be below GAS_RESERVE_AFTER_FAIL.
    /// @return released Number of lines actually paid.
    function releaseMany(
        uint256 runId,
        uint256[] calldata idx
    ) external nonReentrant returns (uint256 released) {
        _checkRun(runId);
        Run storage run  = _runs[runId];
        address caller   = msg.sender;

        for (uint256 k; k < idx.length; ++k) {
            uint256 i = idx[k];

            // ── guard: bounds ─────────────────────────
            if (i >= run.lineCount) {
                emit ReleaseSkipped(runId, i, uint8(SkipReason.InvalidIndex));
                continue;
            }

            Line storage line = _lines[runId][i];

            // ── guard: status ─────────────────────────
            if (line.status != Status.Pending) {
                emit ReleaseSkipped(runId, i, uint8(SkipReason.NotPending));
                continue;
            }

            // ── guard: time ───────────────────────────
            if (block.timestamp < line.dueAt) {
                emit ReleaseSkipped(runId, i, uint8(SkipReason.NotDue));
                continue;
            }

            // ── gas floor before attempt ──────────────
            if (gasleft() < MIN_GAS_PER_LINE) revert InsufficientGas();

            // ── atomic line attempt via self-call ─────
            // releaseLineInternal is external but restricted to address(this).
            // Using try/catch ensures a revert inside it cannot bubble up.
            try this.releaseLineInternal(runId, i, caller) {
                emit LineReleased(runId, i, line.recipient, line.amount, caller, line.tip);
                ++released;
            } catch {
                // Distinguish real transfer failure from OOG inside the call.
                if (gasleft() < GAS_RESERVE_AFTER_FAIL) revert InsufficientGas();
                emit ReleaseSkipped(runId, i, uint8(SkipReason.TransferFailed));
            }
        }
    }

    /// @notice Internal entry point called only by releaseMany via address(this).
    ///         Marks the line Paid, transfers amount to recipient and tip to caller.
    ///         Reverts on any transfer failure, leaving the line Pending.
    /// @dev    NOT nonReentrant: it is called from within a nonReentrant context.
    ///         The self-call is synchronous and nested re-entrance is blocked by
    ///         the parent's nonReentrant guard.
    function releaseLineInternal(
        uint256 runId,
        uint256 i,
        address caller
    ) external {
        if (msg.sender != address(this)) revert OnlySelf();

        Line storage line = _lines[runId][i];

        // Effects before interactions.
        line.status = Status.Paid;

        token.safeTransfer(line.recipient, line.amount);
        if (line.tip > 0) {
            token.safeTransfer(caller, line.tip);
        }
        // Event is emitted by releaseMany after a successful try-branch.
    }

    // ──────────────────────────────────────────────────
    // Core: decline
    // ──────────────────────────────────────────────────

    /// @notice Recipient declines a Pending line; full amount + tip refunded to payer.
    function decline(uint256 runId, uint256 i) external nonReentrant {
        _checkRunAndLine(runId, i);
        Line storage line = _lines[runId][i];
        if (line.status != Status.Pending) revert NotPending();
        if (line.recipient != msg.sender)  revert NotRecipient();

        address payer  = _runs[runId].payer;
        uint128 amount = line.amount;
        uint96  tip    = line.tip;

        // Effects before interactions.
        line.status = Status.Declined;

        token.safeTransfer(payer, uint256(amount) + uint256(tip));

        emit LineDeclined(runId, i, msg.sender, amount, tip);
    }

    // ──────────────────────────────────────────────────
    // Core: cancel
    // ──────────────────────────────────────────────────

    /// @notice Payer cancels a subset of Pending lines on a non-committed run.
    ///         Only lines whose dueAt has not yet passed may be cancelled.
    function cancel(
        uint256 runId,
        uint256[] calldata idx
    ) external nonReentrant {
        _checkRun(runId);
        Run storage run = _runs[runId];
        if (run.payer != msg.sender) revert NotPayer();
        if (run.committed) revert RunCommitted();

        for (uint256 k; k < idx.length; ++k) {
            uint256 i = idx[k];
            _checkLineIndex(runId, i);
            Line storage line = _lines[runId][i];
            if (line.status != Status.Pending) revert NotPending();
            if (block.timestamp >= line.dueAt) revert AlreadyDue();

            uint128 amount = line.amount;
            uint96  tip    = line.tip;

            // Effects before interactions.
            line.status = Status.Cancelled;

            token.safeTransfer(msg.sender, uint256(amount) + uint256(tip));

            emit LineCancelled(runId, i, amount, tip);
        }
    }

    // ──────────────────────────────────────────────────
    // Core: reclaimStale
    // ──────────────────────────────────────────────────

    /// @notice Payer reclaims a Pending line that has been overdue for
    ///         at least STALE_PERIOD.
    function reclaimStale(uint256 runId, uint256 i) external nonReentrant {
        _checkRunAndLine(runId, i);
        Run storage run = _runs[runId];
        if (run.payer != msg.sender) revert NotPayer();

        Line storage line = _lines[runId][i];
        if (line.status != Status.Pending) revert NotPending();
        if (block.timestamp < line.dueAt + STALE_PERIOD) revert NotStale();

        uint128 amount = line.amount;
        uint96  tip    = line.tip;

        // Effects before interactions.
        line.status = Status.Reclaimed;

        token.safeTransfer(msg.sender, uint256(amount) + uint256(tip));

        emit LineReclaimed(runId, i, amount, tip);
    }

    // ──────────────────────────────────────────────────
    // Views
    // ──────────────────────────────────────────────────

    function getRun(uint256 runId) external view returns (Run memory) {
        _checkRun(runId);
        return _runs[runId];
    }

    function getLine(uint256 runId, uint256 i) external view returns (Line memory) {
        _checkRunAndLine(runId, i);
        return _lines[runId][i];
    }

    /// @notice Returns all lines for a run.
    function getLines(uint256 runId) external view returns (Line[] memory arr) {
        _checkRun(runId);
        uint256 n = _runs[runId].lineCount;
        arr = new Line[](n);
        for (uint256 i; i < n; ++i) {
            arr[i] = _lines[runId][i];
        }
    }

    /// @notice Returns all runIds for a payer.
    function runsOfPayer(address payer) external view returns (uint256[] memory) {
        return _runsOfPayer[payer];
    }

    /// @notice Paginated runIds for a payer.
    function runsOfPayer(
        address payer,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory page) {
        uint256[] storage arr = _runsOfPayer[payer];
        uint256 total = arr.length;
        if (offset >= total) return page;
        uint256 end = (limit > total - offset) ? total : offset + limit;
        page = new uint256[](end - offset);
        for (uint256 i; i < page.length; ++i) {
            page[i] = arr[offset + i];
        }
    }

    /// @notice Number of runs a payer has created.
    function runsOfPayerCount(address payer) external view returns (uint256) {
        return _runsOfPayer[payer].length;
    }

    /// @notice Returns all LineRef pairs for a recipient.
    function linesOfRecipient(address recipient) external view returns (LineRef[] memory) {
        return _linesOfRecipient[recipient];
    }

    /// @notice Paginated LineRef pairs for a recipient.
    function linesOfRecipient(
        address recipient,
        uint256 offset,
        uint256 limit
    ) external view returns (LineRef[] memory page) {
        LineRef[] storage arr = _linesOfRecipient[recipient];
        uint256 total = arr.length;
        if (offset >= total) return page;
        uint256 end = (limit > total - offset) ? total : offset + limit;
        page = new LineRef[](end - offset);
        for (uint256 i; i < page.length; ++i) {
            page[i] = arr[offset + i];
        }
    }

    /// @notice Number of lines a recipient is referenced in.
    function linesOfRecipientCount(address recipient) external view returns (uint256) {
        return _linesOfRecipient[recipient].length;
    }

    function isDue(uint256 runId, uint256 i) external view returns (bool) {
        _checkRunAndLine(runId, i);
        return block.timestamp >= _lines[runId][i].dueAt;
    }

    // ──────────────────────────────────────────────────
    // Internals
    // ──────────────────────────────────────────────────

    /// @dev Single-line release used by release().
    function _release(uint256 runId, uint256 i, address caller) internal {
        Line storage line = _lines[runId][i];
        if (line.status != Status.Pending) revert NotPending();
        if (block.timestamp < line.dueAt)  revert NotDue();

        uint128 amount = line.amount;
        uint96  tip    = line.tip;
        address recip  = line.recipient;

        // Effects before interactions.
        line.status = Status.Paid;

        token.safeTransfer(recip, amount);
        if (tip > 0) {
            token.safeTransfer(caller, tip);
        }

        emit LineReleased(runId, i, recip, amount, caller, tip);
    }

    /// @dev Revert if the run does not exist (payer == address(0)).
    function _checkRun(uint256 runId) internal view {
        if (_runs[runId].payer == address(0)) revert RunNotFound();
    }

    /// @dev Revert if the run does not exist or i is out of bounds.
    function _checkRunAndLine(uint256 runId, uint256 i) internal view {
        _checkRun(runId);
        _checkLineIndex(runId, i);
    }

    /// @dev Revert if i >= lineCount for an already-validated run.
    function _checkLineIndex(uint256 runId, uint256 i) internal view {
        if (i >= _runs[runId].lineCount) revert InvalidLineIndex();
    }
}
