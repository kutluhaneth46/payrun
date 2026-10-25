// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../PayrunVault.sol";

// ───────────────────────────────────────────────────────────────────
// Blocking mock: reverts transfer to/from a configured address.
// Deployed at a fresh address so the invariant vault can use it.
// ───────────────────────────────────────────────────────────────────
contract BlockingMockUSDC {
    string public name     = "Blocking USDC";
    string public symbol   = "USDC";
    uint8  public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isBlocked;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setBlocked(address addr, bool blocked) external {
        isBlocked[addr] = blocked;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!isBlocked[to],          "USDC: account is blacklisted");
        require(!isBlocked[msg.sender],  "USDC: account is blacklisted");
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!isBlocked[from], "USDC: account is blacklisted");
        require(!isBlocked[to],   "USDC: account is blacklisted");
        require(balanceOf[from] >= amount,              "insufficient");
        require(allowance[from][msg.sender] >= amount,  "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}

// ───────────────────────────────────────────────────────────────────
// Handler
// ───────────────────────────────────────────────────────────────────
contract PayrunHandler is Test {
    PayrunVault      public vault;
    BlockingMockUSDC public token;

    // Actors.
    address[] public payers;
    address[] public recipients;
    address   public relayer;

    // Ghost tracking.
    uint256[] public runIds;
    // per-line settled-count: keccak(runId, lineIndex) => count
    mapping(bytes32 => uint256) public settledCount;
    // Set to true if any settle operation succeeds on a non-Pending line.
    bool public ghostDoubleSettle;

    // Accounting ghosts.
    uint256 public ghostDeposited;   // total locked by createRun
    uint256 public ghostPaidOut;     // total sent to recipients (release/releaseMany)
    uint256 public ghostTipsOut;     // total tips to relayers
    uint256 public ghostRefunded;    // total refunded to payers (decline/cancel/reclaimStale)

    constructor(PayrunVault _vault, BlockingMockUSDC _token) {
        vault   = _vault;
        token   = _token;
        relayer = makeAddr("relayer_inv");

        for (uint256 i; i < 3; ++i) {
            address p = makeAddr(string(abi.encodePacked("payer_inv_", i)));
            address r = makeAddr(string(abi.encodePacked("recip_inv_", i)));
            payers.push(p);
            recipients.push(r);
            token.mint(p, 100_000e6);
            vm.prank(p);
            token.approve(address(vault), type(uint256).max);
        }
    }

    // ── createRun ────────────────────────────────────────

    function createRun(uint256 payerSeed, uint256 lineCount, uint256 seed) external {
        address payer = payers[payerSeed % payers.length];
        lineCount = bound(lineCount, 1, 5);

        PayrunVault.LineInput[] memory lines = new PayrunVault.LineInput[](lineCount);
        uint256 total;
        for (uint256 i; i < lineCount; ++i) {
            uint256 r      = uint256(keccak256(abi.encode(seed, i)));
            uint128 amount = uint128(bound(r, 1e6, 20e6));
            uint96  tip    = uint96(bound(r >> 64, 0, vault.MAX_TIP()));
            total += uint256(amount) + uint256(tip);
            if (total > vault.MAX_RUN_TOTAL()) return;

            address recip = recipients[r % recipients.length];
            if (recip == payer) recip = recipients[(r + 1) % recipients.length];

            lines[i] = PayrunVault.LineInput({
                recipient: recip,
                amount:    amount,
                tip:       tip,
                dueAt:     uint64(block.timestamp + 1 days),
                lineRef:   bytes32(0)
            });
        }

        vm.prank(payer);
        uint256 runId = vault.createRun(lines, false, bytes32(0));
        runIds.push(runId);
        ghostDeposited += total;
    }

    // ── release ──────────────────────────────────────────

    function release(uint256 runSeed, uint256 lineSeed) external {
        if (runIds.length == 0) return;
        uint256 runId = runIds[runSeed % runIds.length];
        PayrunVault.Run memory run = vault.getRun(runId);
        if (run.lineCount == 0) return;
        uint256 i = lineSeed % run.lineCount;

        PayrunVault.Line memory line = vault.getLine(runId, i);
        if (line.status != PayrunVault.Status.Pending) return;
        if (block.timestamp < line.dueAt) return;

        vm.prank(relayer);
        vault.release(runId, i);

        bytes32 key = keccak256(abi.encode(runId, i));
        settledCount[key]++;
        ghostPaidOut += line.amount;
        ghostTipsOut += line.tip;
    }

    // ── releaseMany ──────────────────────────────────────

    function releaseMany(uint256 runSeed, uint256 lineSeed) external {
        if (runIds.length == 0) return;
        uint256 runId = runIds[runSeed % runIds.length];
        PayrunVault.Run memory run = vault.getRun(runId);
        if (run.lineCount == 0) return;

        uint256 n = bound(lineSeed, 1, run.lineCount);
        uint256[] memory idx = new uint256[](n);
        for (uint256 k; k < n; ++k) {
            // Overflow-safe: use two-step modulo to spread indices.
            idx[k] = (lineSeed % run.lineCount + k) % run.lineCount;
        }

        // Record Pending status before attempting.
        bool[] memory wasPending = new bool[](n);
        uint128[] memory amounts = new uint128[](n);
        uint96[]  memory tips    = new uint96[](n);
        for (uint256 k; k < n; ++k) {
            PayrunVault.Line memory l = vault.getLine(runId, idx[k]);
            wasPending[k] = (l.status == PayrunVault.Status.Pending) && (block.timestamp >= l.dueAt);
            amounts[k]    = l.amount;
            tips[k]       = l.tip;
        }

        vm.prank(relayer);
        try vault.releaseMany(runId, idx) {
            // Update ghosts for lines that were eligible and not blocked.
            for (uint256 k; k < n; ++k) {
                PayrunVault.Line memory lineAfter = vault.getLine(runId, idx[k]);
                if (wasPending[k] && lineAfter.status == PayrunVault.Status.Paid) {
                    bytes32 key = keccak256(abi.encode(runId, idx[k]));
                    settledCount[key]++;
                    ghostPaidOut += amounts[k];
                    ghostTipsOut += tips[k];
                }
            }
        } catch { }
    }

    // ── decline ──────────────────────────────────────────

    function decline(uint256 runSeed, uint256 lineSeed) external {
        if (runIds.length == 0) return;
        uint256 runId = runIds[runSeed % runIds.length];
        PayrunVault.Run memory run = vault.getRun(runId);
        if (run.lineCount == 0) return;
        uint256 i = lineSeed % run.lineCount;

        PayrunVault.Line memory line = vault.getLine(runId, i);
        if (line.status != PayrunVault.Status.Pending) return;

        vm.prank(line.recipient);
        try vault.decline(runId, i) {
            bytes32 key = keccak256(abi.encode(runId, i));
            settledCount[key]++;
            ghostRefunded += uint256(line.amount) + uint256(line.tip);
        } catch { }
    }

    // ── cancel ───────────────────────────────────────────

    function cancel(uint256 runSeed, uint256 lineSeed) external {
        if (runIds.length == 0) return;
        uint256 runId = runIds[runSeed % runIds.length];
        PayrunVault.Run memory run = vault.getRun(runId);
        if (run.committed) return;
        if (run.lineCount == 0) return;
        uint256 i = lineSeed % run.lineCount;

        PayrunVault.Line memory line = vault.getLine(runId, i);
        if (line.status != PayrunVault.Status.Pending) return;
        if (block.timestamp >= line.dueAt) return;

        uint256[] memory idx = new uint256[](1); idx[0] = i;
        vm.prank(run.payer);
        try vault.cancel(runId, idx) {
            bytes32 key = keccak256(abi.encode(runId, i));
            settledCount[key]++;
            ghostRefunded += uint256(line.amount) + uint256(line.tip);
        } catch { }
    }

    // ── reclaimStale ─────────────────────────────────────

    function reclaimStale(uint256 runSeed, uint256 lineSeed) external {
        if (runIds.length == 0) return;
        uint256 runId = runIds[runSeed % runIds.length];
        PayrunVault.Run memory run = vault.getRun(runId);
        if (run.lineCount == 0) return;
        uint256 i = lineSeed % run.lineCount;

        PayrunVault.Line memory line = vault.getLine(runId, i);
        if (line.status != PayrunVault.Status.Pending) return;
        if (block.timestamp < line.dueAt + vault.STALE_PERIOD()) return;

        vm.prank(run.payer);
        try vault.reclaimStale(runId, i) {
            bytes32 key = keccak256(abi.encode(runId, i));
            settledCount[key]++;
            ghostRefunded += uint256(line.amount) + uint256(line.tip);
        } catch { }
    }

    // ── toggleBlock ──────────────────────────────────────
    // Block or unblock a recipient or the relayer to exercise the blocking path.

    function toggleBlock(uint256 seed) external {
        uint256 choice = seed % (recipients.length + 1);
        address target = (choice < recipients.length) ? recipients[choice] : relayer;
        token.setBlocked(target, !token.isBlocked(target));
    }

    // ── trySettleAlreadySettled ───────────────────────────
    // Attempt settle operations on already-settled lines.
    // Any success sets ghostDoubleSettle = true (a revert() inside a try-success
    // block never fails the run under fail_on_revert=false, so a flag is the only
    // reliable way to detect a spurious success and surface it via an invariant).

    function trySettleAlreadySettled(uint256 runSeed, uint256 lineSeed) external {
        if (runIds.length == 0) return;
        uint256 runId = runIds[runSeed % runIds.length];
        PayrunVault.Run memory run = vault.getRun(runId);
        if (run.lineCount == 0) return;
        uint256 i = lineSeed % run.lineCount;

        PayrunVault.Line memory line = vault.getLine(runId, i);
        if (line.status == PayrunVault.Status.Pending) return; // only test non-Pending

        // release should revert on a non-Pending line.
        vm.prank(relayer);
        try vault.release(runId, i) {
            ghostDoubleSettle = true; // success is a bug
        } catch { }

        // decline should revert on a non-Pending line.
        vm.prank(line.recipient);
        try vault.decline(runId, i) {
            ghostDoubleSettle = true;
        } catch { }

        // reclaimStale should revert on a non-Pending line.
        vm.prank(run.payer);
        try vault.reclaimStale(runId, i) {
            ghostDoubleSettle = true;
        } catch { }

        // releaseMany on a single already-settled index should leave status unchanged.
        uint256[] memory idx = new uint256[](1);
        idx[0] = i;
        PayrunVault.Status statusBefore = vault.getLine(runId, i).status;
        vm.prank(relayer);
        try vault.releaseMany(runId, idx) { } catch { }
        PayrunVault.Status statusAfter = vault.getLine(runId, i).status;
        if (statusAfter != statusBefore) {
            ghostDoubleSettle = true; // status changed — that is a bug
        }
    }

    // ── warpForward ──────────────────────────────────────

    function warpForward(uint256 secs) external {
        secs = bound(secs, 1, 45 days);
        vm.warp(block.timestamp + secs);
    }

    // ── length helpers ───────────────────────────────────

    function runIdsLength() external view returns (uint256) { return runIds.length; }

    // ── ghost helpers ─────────────────────────────────────

    function _pendingSum() public view returns (uint256 total) {
        for (uint256 r; r < runIds.length; ++r) {
            uint256 runId = runIds[r];
            PayrunVault.Run memory run = vault.getRun(runId);
            for (uint256 i; i < run.lineCount; ++i) {
                PayrunVault.Line memory line = vault.getLine(runId, i);
                if (line.status == PayrunVault.Status.Pending) {
                    total += uint256(line.amount) + uint256(line.tip);
                }
            }
        }
    }
}

// ───────────────────────────────────────────────────────────────────
// Invariant test contract
// ───────────────────────────────────────────────────────────────────
contract PayrunVaultInvariantTest is Test {
    PayrunVault      vault;
    BlockingMockUSDC token;
    PayrunHandler    handler;

    function setUp() public {
        token   = new BlockingMockUSDC();
        vault   = new PayrunVault(address(token));
        handler = new PayrunHandler(vault, token);

        targetContract(address(handler));
    }

    // Invariant 1: vault token balance == sum of (amount+tip) over all Pending lines.
    function invariant_vaultBalanceEqualsPendingSum() public view {
        uint256 vaultBal    = token.balanceOf(address(vault));
        uint256 pendingSum  = handler._pendingSum();
        assertEq(vaultBal, pendingSum, "I1: vault balance != pending sum");
    }

    // Invariant 2: each line's ghost settled-count never exceeds 1.
    function invariant_noLinePaidTwice() public view {
        uint256 nRuns = handler.runIdsLength();
        for (uint256 r; r < nRuns; ++r) {
            uint256 runId = handler.runIds(r);
            PayrunVault.Run memory run = vault.getRun(runId);
            for (uint256 i; i < run.lineCount; ++i) {
                bytes32 key = keccak256(abi.encode(runId, i));
                assertLe(handler.settledCount(key), 1, "I2: line settled more than once");
            }
        }
    }

    // Invariant 3: no settle operation ever succeeded on a non-Pending line.
    function invariant_noDoubleSettle() public view {
        assertFalse(handler.ghostDoubleSettle(), "I3: double-settle detected");
    }

    // Invariant 4: deposited == paidOut + tipsOut + refunded + pending.
    function invariant_depositedEqualsPaidOutPlusPending() public view {
        uint256 pending = handler._pendingSum();
        uint256 accounted = handler.ghostPaidOut()
            + handler.ghostTipsOut()
            + handler.ghostRefunded()
            + pending;
        assertEq(handler.ghostDeposited(), accounted, "I3: accounting mismatch");
    }
}
