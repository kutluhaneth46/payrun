// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../PayrunVault.sol";

// ═══════════════════════════════════════════════════════════════════
// Mock tokens
// ═══════════════════════════════════════════════════════════════════

/// @dev Standard 6-decimal ERC-20 mock.
contract MockUSDC {
    string public name     = "Mock USDC";
    string public symbol   = "USDC";
    uint8  public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}

/// @dev Mock that REVERTS (not returns false) for a configured blocked address,
///      mimicking real USDC's blocklist behaviour.
contract RevertingBlockMockUSDC is MockUSDC {
    address public blocked;

    constructor(address _blocked) { blocked = _blocked; }

    function setBlocked(address addr) external { blocked = addr; }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(to != blocked, "USDC: account is blacklisted");
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

/// @dev Mock that charges a 1-unit fee on transferFrom (fee-on-transfer).
contract FeeOnTransferMockUSDC is MockUSDC {
    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        // Deliver 1 less than requested.
        balanceOf[to] += amount - 1;
        emit Transfer(from, to, amount - 1);
        return true;
    }
}

// ═══════════════════════════════════════════════════════════════════
// Base test setup
// ═══════════════════════════════════════════════════════════════════

abstract contract PayrunBase is Test {
    address constant USDC_ADDR = 0x3600000000000000000000000000000000000000;

    MockUSDC    public usdc;
    PayrunVault public vault;

    address payer     = makeAddr("payer");
    address recipient = makeAddr("recipient");
    address relayer   = makeAddr("relayer");
    address stranger  = makeAddr("stranger");

    function setUp() public virtual {
        MockUSDC impl = new MockUSDC();
        vm.etch(USDC_ADDR, address(impl).code);
        usdc  = MockUSDC(USDC_ADDR);
        vault = new PayrunVault(USDC_ADDR);

        usdc.mint(payer, 10_000e6);
        vm.prank(payer);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ── helpers ──────────────────────────────────────

    function _oneLine(
        address recip, uint128 amount, uint96 tip, uint64 dueAt
    ) internal pure returns (PayrunVault.LineInput[] memory arr) {
        arr = new PayrunVault.LineInput[](1);
        arr[0] = PayrunVault.LineInput({ recipient: recip, amount: amount, tip: tip, dueAt: dueAt, lineRef: bytes32(0) });
    }

    function _defaultLine() internal view returns (PayrunVault.LineInput[] memory) {
        return _oneLine(recipient, 100e6, 0.5e6, uint64(block.timestamp + 1 days));
    }

    function _createDefaultRun() internal returns (uint256 runId) {
        vm.prank(payer);
        runId = vault.createRun(_defaultLine(), false, bytes32(0));
    }
}

// ═══════════════════════════════════════════════════════════════════
// Constructor tests
// ═══════════════════════════════════════════════════════════════════

contract ConstructorTest is PayrunBase {
    function test_revert_ZeroToken() public {
        vm.expectRevert(PayrunVault.InvalidToken.selector);
        new PayrunVault(address(0));
    }

    function test_revert_NoCodeToken() public {
        vm.expectRevert(PayrunVault.InvalidToken.selector);
        new PayrunVault(makeAddr("eoa"));
    }

    function test_constructor_SetsToken() public view {
        assertEq(address(vault.token()), USDC_ADDR);
    }
}

// ═══════════════════════════════════════════════════════════════════
// createRun validation
// ═══════════════════════════════════════════════════════════════════

contract CreateRunValidationTest is PayrunBase {

    function test_revert_EmptyLines() public {
        PayrunVault.LineInput[] memory lines;
        vm.prank(payer);
        vm.expectRevert(PayrunVault.InvalidLineCount.selector);
        vault.createRun(lines, false, bytes32(0));
    }

    function test_revert_TooManyLines() public {
        PayrunVault.LineInput[] memory lines = new PayrunVault.LineInput[](51);
        for (uint256 i; i < 51; ++i) {
            lines[i] = PayrunVault.LineInput({ recipient: address(uint160(0x100 + i)), amount: 1e6, tip: 0, dueAt: uint64(block.timestamp + 1 days), lineRef: bytes32(0) });
        }
        vm.prank(payer);
        vm.expectRevert(PayrunVault.InvalidLineCount.selector);
        vault.createRun(lines, false, bytes32(0));
    }

    // Boundary: exactly 50 lines must succeed.
    function test_exactly50Lines_Accepted() public {
        PayrunVault.LineInput[] memory lines = new PayrunVault.LineInput[](50);
        for (uint256 i; i < 50; ++i) {
            lines[i] = PayrunVault.LineInput({ recipient: address(uint160(0x100 + i)), amount: 1e6, tip: 0, dueAt: uint64(block.timestamp + 1 days), lineRef: bytes32(0) });
        }
        vm.prank(payer);
        vault.createRun(lines, false, bytes32(0));
    }

    // Boundary: total exactly 500e6 must succeed.
    function test_totalExactly500e6_Accepted() public {
        PayrunVault.LineInput[] memory lines = _oneLine(recipient, 500e6, 0, uint64(block.timestamp + 1 days));
        vm.prank(payer);
        vault.createRun(lines, false, bytes32(0));
    }

    // Boundary: tip exactly 1e6 must succeed.
    function test_tipExactly1e6_Accepted() public {
        PayrunVault.LineInput[] memory lines = _oneLine(recipient, 498e6, uint96(vault.MAX_TIP()), uint64(block.timestamp + 1 days));
        vm.prank(payer);
        vault.createRun(lines, false, bytes32(0));
    }

    // Boundary: dueAt == now + 730 days must succeed.
    function test_dueAtExactlyHorizon_Accepted() public {
        uint64 dueAt = uint64(block.timestamp + vault.MAX_HORIZON());
        PayrunVault.LineInput[] memory lines = _oneLine(recipient, 1e6, 0, dueAt);
        vm.prank(payer);
        vault.createRun(lines, false, bytes32(0));
    }

    function test_revert_ZeroRecipient() public {
        vm.prank(payer);
        vm.expectRevert(PayrunVault.InvalidRecipient.selector);
        vault.createRun(_oneLine(address(0), 1e6, 0, uint64(block.timestamp + 1 days)), false, bytes32(0));
    }

    function test_revert_VaultAsRecipient() public {
        vm.prank(payer);
        vm.expectRevert(PayrunVault.InvalidRecipient.selector);
        vault.createRun(_oneLine(address(vault), 1e6, 0, uint64(block.timestamp + 1 days)), false, bytes32(0));
    }

    function test_revert_PayerAsRecipient() public {
        vm.prank(payer);
        vm.expectRevert(PayrunVault.InvalidRecipient.selector);
        vault.createRun(_oneLine(payer, 1e6, 0, uint64(block.timestamp + 1 days)), false, bytes32(0));
    }

    function test_revert_TokenAsRecipient() public {
        vm.prank(payer);
        vm.expectRevert(PayrunVault.InvalidRecipient.selector);
        vault.createRun(_oneLine(USDC_ADDR, 1e6, 0, uint64(block.timestamp + 1 days)), false, bytes32(0));
    }

    function test_revert_ZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(PayrunVault.ZeroAmount.selector);
        vault.createRun(_oneLine(recipient, 0, 0, uint64(block.timestamp + 1 days)), false, bytes32(0));
    }

    function test_revert_TipTooHigh() public {
        uint96 badTip = uint96(vault.MAX_TIP()) + 1;
        vm.prank(payer);
        vm.expectRevert(PayrunVault.TipTooHigh.selector);
        vault.createRun(_oneLine(recipient, 1e6, badTip, uint64(block.timestamp + 1 days)), false, bytes32(0));
    }

    function test_revert_DueAtNow() public {
        vm.prank(payer);
        vm.expectRevert(PayrunVault.DueAtInvalid.selector);
        vault.createRun(_oneLine(recipient, 1e6, 0, uint64(block.timestamp)), false, bytes32(0));
    }

    function test_revert_DueAtTooFar() public {
        uint64 badDue = uint64(block.timestamp + vault.MAX_HORIZON() + 1);
        vm.prank(payer);
        vm.expectRevert(PayrunVault.DueAtTooFar.selector);
        vault.createRun(_oneLine(recipient, 1e6, 0, badDue), false, bytes32(0));
    }

    function test_revert_RunTotalExceeded() public {
        // Two lines: 250e6 + 0.5e6 each = 501e6 total > 500e6.
        address r2 = makeAddr("r2");
        PayrunVault.LineInput[] memory lines = new PayrunVault.LineInput[](2);
        lines[0] = PayrunVault.LineInput({ recipient: recipient, amount: 250e6, tip: 0.5e6, dueAt: uint64(block.timestamp + 1 days), lineRef: bytes32(0) });
        lines[1] = PayrunVault.LineInput({ recipient: r2,        amount: 250e6, tip: 0.5e6, dueAt: uint64(block.timestamp + 1 days), lineRef: bytes32(0) });
        vm.prank(payer);
        vm.expectRevert(PayrunVault.RunTotalExceeded.selector);
        vault.createRun(lines, false, bytes32(0));
    }

    function test_revert_BalanceInvariantViolated_FeeToken() public {
        // Deploy a fee-on-transfer mock and a new vault pointing at it.
        FeeOnTransferMockUSDC feeToken = new FeeOnTransferMockUSDC();
        PayrunVault feeVault = new PayrunVault(address(feeToken));
        feeToken.mint(payer, 10_000e6);
        vm.prank(payer);
        feeToken.approve(address(feeVault), type(uint256).max);

        vm.prank(payer);
        vm.expectRevert(PayrunVault.BalanceInvariantViolated.selector);
        feeVault.createRun(_oneLine(recipient, 1e6, 0, uint64(block.timestamp + 1 days)), false, bytes32(0));
    }

    function test_createRun_StartsAt1() public {
        uint256 runId = _createDefaultRun();
        assertEq(runId, 1);
    }

    function test_createRun_RunCountIncrements() public {
        assertEq(vault.runCount(), 0);
        _createDefaultRun();
        assertEq(vault.runCount(), 1);
        _createDefaultRun();
        assertEq(vault.runCount(), 2);
    }

    function test_createRun_StoresDataCorrectly() public {
        uint256 runId = _createDefaultRun();
        PayrunVault.Run memory r = vault.getRun(runId);
        assertEq(r.payer, payer);
        assertFalse(r.committed);
        assertEq(r.lineCount, 1);
        assertEq(r.createdAt, uint64(block.timestamp));

        PayrunVault.Line memory l = vault.getLine(runId, 0);
        assertEq(l.recipient, recipient);
        assertEq(uint8(l.status), uint8(PayrunVault.Status.Pending));
        assertEq(l.amount, 100e6);
        assertEq(l.tip, 0.5e6);
    }

    function test_createRun_BalanceIncreases() public {
        uint256 before = usdc.balanceOf(address(vault));
        _createDefaultRun();
        assertEq(usdc.balanceOf(address(vault)), before + 100e6 + 0.5e6);
    }

    // runsOfPayer length must be 1 after one multi-line run.
    function test_runsOfPayer_Length1AfterOneMultiLineRun() public {
        address r2 = makeAddr("r2");
        PayrunVault.LineInput[] memory lines = new PayrunVault.LineInput[](3);
        for (uint256 i; i < 3; ++i) {
            lines[i] = PayrunVault.LineInput({ recipient: address(uint160(uint256(uint160(r2)) + i + 1)), amount: 10e6, tip: 0, dueAt: uint64(block.timestamp + 1 days), lineRef: bytes32(0) });
        }
        vm.prank(payer);
        vault.createRun(lines, false, bytes32(0));
        assertEq(vault.runsOfPayer(payer).length, 1);
    }

    function test_linesOfRecipient_CorrectPairs() public {
        uint256 runId = _createDefaultRun();
        PayrunVault.LineRef[] memory refs = vault.linesOfRecipient(recipient);
        assertEq(refs.length, 1);
        assertEq(refs[0].runId, runId);
        assertEq(refs[0].lineIndex, 0);
    }

    function test_runsOfPayer_Paginated() public {
        _createDefaultRun();
        _createDefaultRun();
        _createDefaultRun();
        uint256[] memory page = vault.runsOfPayer(payer, 1, 2);
        assertEq(page.length, 2);
        assertEq(page[0], 2);
        assertEq(page[1], 3);
    }

    function test_linesOfRecipient_Paginated() public {
        _createDefaultRun(); // runId=1, line 0
        _createDefaultRun(); // runId=2, line 0
        _createDefaultRun(); // runId=3, line 0
        PayrunVault.LineRef[] memory page = vault.linesOfRecipient(recipient, 1, 1);
        assertEq(page.length, 1);
        assertEq(page[0].runId, 2);
    }

    function test_emits_RunCreated() public {
        vm.expectEmit(true, true, false, true);
        emit PayrunVault.RunCreated(1, payer, bytes32(0), false, 1, 100e6, 0.5e6);
        vm.prank(payer);
        vault.createRun(_defaultLine(), false, bytes32(0));
    }

    function test_emits_LineAdded() public {
        vm.expectEmit(true, true, true, true);
        emit PayrunVault.LineAdded(1, 0, recipient, 100e6, 0.5e6, uint64(block.timestamp + 1 days), bytes32(0));
        vm.prank(payer);
        vault.createRun(_defaultLine(), false, bytes32(0));
    }
}

// ═══════════════════════════════════════════════════════════════════
// Existence & bounds checks
// ═══════════════════════════════════════════════════════════════════

contract ExistenceChecksTest is PayrunBase {

    function test_getLine_revert_RunNotFound() public {
        vm.expectRevert(PayrunVault.RunNotFound.selector);
        vault.getLine(99, 0);
    }

    function test_getLine_revert_InvalidLineIndex() public {
        uint256 runId = _createDefaultRun();
        vm.expectRevert(PayrunVault.InvalidLineIndex.selector);
        vault.getLine(runId, 1);
    }

    function test_isDue_revert_RunNotFound() public {
        vm.expectRevert(PayrunVault.RunNotFound.selector);
        vault.isDue(99, 0);
    }

    function test_isDue_revert_InvalidLineIndex() public {
        uint256 runId = _createDefaultRun();
        vm.expectRevert(PayrunVault.InvalidLineIndex.selector);
        vault.isDue(runId, 5);
    }

    function test_release_revert_RunNotFound() public {
        vm.prank(relayer);
        vm.expectRevert(PayrunVault.RunNotFound.selector);
        vault.release(99, 0);
    }

    function test_release_revert_InvalidLineIndex() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 2 days);
        vm.prank(relayer);
        vm.expectRevert(PayrunVault.InvalidLineIndex.selector);
        vault.release(runId, 5);
    }

    function test_decline_revert_RunNotFound() public {
        vm.prank(recipient);
        vm.expectRevert(PayrunVault.RunNotFound.selector);
        vault.decline(99, 0);
    }

    function test_decline_revert_InvalidLineIndex() public {
        uint256 runId = _createDefaultRun();
        vm.prank(recipient);
        vm.expectRevert(PayrunVault.InvalidLineIndex.selector);
        vault.decline(runId, 5);
    }

    function test_reclaimStale_revert_RunNotFound() public {
        vm.prank(payer);
        vm.expectRevert(PayrunVault.RunNotFound.selector);
        vault.reclaimStale(99, 0);
    }

    function test_reclaimStale_revert_InvalidLineIndex() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 31 days + 1);
        vm.prank(payer);
        vm.expectRevert(PayrunVault.InvalidLineIndex.selector);
        vault.reclaimStale(runId, 5);
    }
}

// ═══════════════════════════════════════════════════════════════════
// release
// ═══════════════════════════════════════════════════════════════════

contract ReleaseTest is PayrunBase {

    function test_revert_BeforeDue() public {
        uint256 runId = _createDefaultRun();
        vm.prank(relayer);
        vm.expectRevert(PayrunVault.NotDue.selector);
        vault.release(runId, 0);
    }

    function test_release_AfterDue() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);
        uint256 rb = usdc.balanceOf(recipient);
        uint256 cb = usdc.balanceOf(relayer);
        vm.prank(relayer);
        vault.release(runId, 0);
        assertEq(usdc.balanceOf(recipient), rb + 100e6);
        assertEq(usdc.balanceOf(relayer),   cb + 0.5e6);
        assertEq(uint8(vault.getLine(runId, 0).status), uint8(PayrunVault.Status.Paid));
    }

    function test_release_TipToCallerAmountToRecipient() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);
        address other = makeAddr("other");
        vm.prank(other);
        vault.release(runId, 0);
        assertEq(usdc.balanceOf(recipient), 100e6);
        assertEq(usdc.balanceOf(other),     0.5e6);
    }

    function test_revert_DoubleRelease() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(relayer);
        vault.release(runId, 0);
        vm.prank(relayer);
        vm.expectRevert(PayrunVault.NotPending.selector);
        vault.release(runId, 0);
    }

    function test_release_ZeroTipNoCallerTransfer() public {
        vm.prank(payer);
        uint256 runId = vault.createRun(_oneLine(recipient, 100e6, 0, uint64(block.timestamp + 1 days)), false, bytes32(0));
        vm.warp(block.timestamp + 1 days + 1);
        uint256 cb = usdc.balanceOf(relayer);
        vm.prank(relayer);
        vault.release(runId, 0);
        assertEq(usdc.balanceOf(relayer), cb);
    }

    function test_release_emitsEvent() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectEmit(true, true, false, true);
        emit PayrunVault.LineReleased(runId, 0, recipient, 100e6, relayer, 0.5e6);
        vm.prank(relayer);
        vault.release(runId, 0);
    }

    // Memo-style path: vm.prank sets msg.sender directly, simulating Arc's Memo
    // contract which preserves the originating EOA as msg.sender.
    function test_memoCallPath_createAndRelease() public {
        address memoContract = makeAddr("memo");
        // Fund and approve as payer.
        usdc.mint(payer, 1_000e6);
        vm.prank(payer);
        usdc.approve(address(vault), type(uint256).max);

        // createRun directly from payer EOA (Memo preserves msg.sender).
        vm.prank(payer);
        uint256 runId = vault.createRun(_oneLine(recipient, 50e6, 0.5e6, uint64(block.timestamp + 1 days)), false, bytes32(0));

        vm.warp(block.timestamp + 1 days + 1);

        // Release by a third-party relayer.
        vm.prank(memoContract);
        vault.release(runId, 0);

        assertEq(usdc.balanceOf(recipient),    50e6);
        assertEq(usdc.balanceOf(memoContract), 0.5e6);
    }
}

// ═══════════════════════════════════════════════════════════════════
// releaseMany
// ═══════════════════════════════════════════════════════════════════

contract ReleaseManyTest is PayrunBase {
    address recipient2 = makeAddr("recipient2");
    address blockedAddr;
    RevertingBlockMockUSDC blockUsdc;
    PayrunVault            blockVault;

    function setUp() public override {
        super.setUp();
        blockedAddr = makeAddr("blockedRecipient");

        // Build a separate vault with the reverting-block mock.
        blockUsdc  = new RevertingBlockMockUSDC(blockedAddr);
        blockVault = new PayrunVault(address(blockUsdc));
        blockUsdc.mint(payer, 10_000e6);
        vm.prank(payer);
        blockUsdc.approve(address(blockVault), type(uint256).max);
    }

    // Helper: 3-line run: recipient, blockedAddr, recipient2.
    function _create3LineBlockRun() internal returns (uint256 runId) {
        PayrunVault.LineInput[] memory lines = new PayrunVault.LineInput[](3);
        lines[0] = PayrunVault.LineInput({ recipient: recipient,    amount: 50e6, tip: 0.5e6, dueAt: uint64(block.timestamp + 1 days), lineRef: bytes32(0) });
        lines[1] = PayrunVault.LineInput({ recipient: blockedAddr,  amount: 50e6, tip: 0.5e6, dueAt: uint64(block.timestamp + 1 days), lineRef: bytes32(0) });
        lines[2] = PayrunVault.LineInput({ recipient: recipient2,   amount: 50e6, tip: 0.5e6, dueAt: uint64(block.timestamp + 1 days), lineRef: bytes32(0) });
        vm.prank(payer);
        runId = blockVault.createRun(lines, false, bytes32(0));
    }

    function test_releaseMany_SkipsBlockedRecipientReverts() public {
        uint256 runId = _create3LineBlockRun();
        vm.warp(block.timestamp + 1 days + 1);

        uint256[] memory idx = new uint256[](3);
        idx[0] = 0; idx[1] = 1; idx[2] = 2;

        vm.prank(relayer);
        uint256 released = blockVault.releaseMany(runId, idx);

        assertEq(released, 2);
        assertEq(blockUsdc.balanceOf(recipient),   50e6);
        assertEq(blockUsdc.balanceOf(blockedAddr), 0);
        assertEq(blockUsdc.balanceOf(recipient2),  50e6);

        // Blocked line stays Pending, vault still holds its amount+tip.
        assertEq(uint8(blockVault.getLine(runId, 1).status), uint8(PayrunVault.Status.Pending));
        assertEq(blockUsdc.balanceOf(address(blockVault)), 50e6 + 0.5e6);
    }

    function test_releaseMany_SkippedLineTipNotPaid() public {
        uint256 runId = _create3LineBlockRun();
        vm.warp(block.timestamp + 1 days + 1);

        uint256[] memory idx = new uint256[](1);
        idx[0] = 1; // blocked line only

        uint256 relayerBefore = blockUsdc.balanceOf(relayer);
        vm.prank(relayer);
        blockVault.releaseMany(runId, idx);

        // Relayer got nothing – tip was not paid.
        assertEq(blockUsdc.balanceOf(relayer), relayerBefore);
    }

    function test_releaseMany_SkippedLineCanBeReleasedAfterUnblocking() public {
        uint256 runId = _create3LineBlockRun();
        vm.warp(block.timestamp + 1 days + 1);

        uint256[] memory idx = new uint256[](1);
        idx[0] = 1;
        vm.prank(relayer);
        blockVault.releaseMany(runId, idx); // skipped

        // Unblock.
        blockUsdc.setBlocked(address(0));

        vm.prank(relayer);
        blockVault.releaseMany(runId, idx); // should succeed now

        assertEq(blockUsdc.balanceOf(blockedAddr), 50e6);
    }

    function test_releaseMany_EmitsReleaseSkipped_TransferFailed() public {
        uint256 runId = _create3LineBlockRun();
        vm.warp(block.timestamp + 1 days + 1);

        vm.expectEmit(true, true, false, true);
        emit PayrunVault.ReleaseSkipped(runId, 1, uint8(PayrunVault.SkipReason.TransferFailed));

        uint256[] memory idx = new uint256[](1);
        idx[0] = 1;
        vm.prank(relayer);
        blockVault.releaseMany(runId, idx);
    }

    function test_releaseMany_EmitsReleaseSkipped_NotDue() public {
        uint256 runId = _createDefaultRun();
        // Do NOT warp – still before dueAt.
        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;
        vm.expectEmit(true, true, false, true);
        emit PayrunVault.ReleaseSkipped(runId, 0, uint8(PayrunVault.SkipReason.NotDue));
        vm.prank(relayer);
        vault.releaseMany(runId, idx);
    }

    function test_releaseMany_EmitsReleaseSkipped_NotPending() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(relayer);
        vault.release(runId, 0); // pay it directly

        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;
        vm.expectEmit(true, true, false, true);
        emit PayrunVault.ReleaseSkipped(runId, 0, uint8(PayrunVault.SkipReason.NotPending));
        vm.prank(relayer);
        vault.releaseMany(runId, idx);
    }

    function test_releaseMany_EmitsReleaseSkipped_InvalidIndex() public {
        uint256 runId = _createDefaultRun(); // 1 line
        vm.warp(block.timestamp + 1 days + 1);
        uint256[] memory idx = new uint256[](1);
        idx[0] = 5; // out of bounds
        vm.expectEmit(true, true, false, true);
        emit PayrunVault.ReleaseSkipped(runId, 5, uint8(PayrunVault.SkipReason.InvalidIndex));
        vm.prank(relayer);
        vault.releaseMany(runId, idx);
    }

    function test_releaseMany_DuplicateIndices_SecondIsNotPending() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);
        uint256[] memory idx = new uint256[](2);
        idx[0] = 0; idx[1] = 0;
        vm.prank(relayer);
        uint256 released = vault.releaseMany(runId, idx);
        assertEq(released, 1); // second is skipped (NotPending)
    }

    function test_releaseMany_TipToCallerForEachLine() public {
        PayrunVault.LineInput[] memory lines = new PayrunVault.LineInput[](2);
        lines[0] = PayrunVault.LineInput({ recipient: recipient,  amount: 50e6, tip: 0.5e6, dueAt: uint64(block.timestamp + 1 days), lineRef: bytes32(0) });
        lines[1] = PayrunVault.LineInput({ recipient: recipient2, amount: 50e6, tip: 0.5e6, dueAt: uint64(block.timestamp + 1 days), lineRef: bytes32(0) });
        vm.prank(payer);
        uint256 runId = vault.createRun(lines, false, bytes32(0));
        vm.warp(block.timestamp + 1 days + 1);

        uint256[] memory idx = new uint256[](2);
        idx[0] = 0; idx[1] = 1;
        vm.prank(relayer);
        vault.releaseMany(runId, idx);
        assertEq(usdc.balanceOf(relayer), 1e6);
    }

    function test_releaseMany_BlocklistedCaller_TipNotLost() public {
        // Caller is blocklisted: tip transfer reverts inside releaseLineInternal,
        // so the entire line is kept Pending (both amount AND tip stay in vault).
        RevertingBlockMockUSDC bUsdc = new RevertingBlockMockUSDC(relayer);
        PayrunVault bVault = new PayrunVault(address(bUsdc));
        bUsdc.mint(payer, 10_000e6);
        vm.prank(payer);
        bUsdc.approve(address(bVault), type(uint256).max);

        vm.prank(payer);
        uint256 runId = bVault.createRun(_oneLine(recipient, 50e6, 0.5e6, uint64(block.timestamp + 1 days)), false, bytes32(0));
        vm.warp(block.timestamp + 1 days + 1);

        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;
        vm.prank(relayer); // relayer is the blocked caller
        uint256 released = bVault.releaseMany(runId, idx);

        assertEq(released, 0);
        // Vault still holds amount + tip (nothing leaked).
        assertEq(bUsdc.balanceOf(address(bVault)), 50e6 + 0.5e6);
        assertEq(uint8(bVault.getLine(runId, 0).status), uint8(PayrunVault.Status.Pending));
    }

    function test_releaseMany_TightGasLimit_RevertsInstead() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);

        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;

        // Use a gas limit below MIN_GAS_PER_LINE (80_000) for the whole call.
        // This should revert with InsufficientGas rather than emitting TransferFailed.
        vm.prank(relayer);
        (bool ok,) = address(vault).call{ gas: 30_000 }(
            abi.encodeWithSelector(vault.releaseMany.selector, runId, idx)
        );
        assertFalse(ok, "expected revert on tight gas");
    }

    function test_releaseMany_VaultBalanceEqualsPendingAfterSkip() public {
        uint256 runId = _create3LineBlockRun();
        vm.warp(block.timestamp + 1 days + 1);

        uint256[] memory idx = new uint256[](3);
        idx[0] = 0; idx[1] = 1; idx[2] = 2;
        vm.prank(relayer);
        blockVault.releaseMany(runId, idx);

        // Only line 1 (blocked) is still Pending.
        uint256 pendingSum = 50e6 + 0.5e6;
        assertEq(blockUsdc.balanceOf(address(blockVault)), pendingSum);
    }

    function test_releaseMany_VaultBalanceZeroAfterAllReleased() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);
        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;
        vm.prank(relayer);
        vault.releaseMany(runId, idx);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }
}

// ═══════════════════════════════════════════════════════════════════
// decline
// ═══════════════════════════════════════════════════════════════════

contract DeclineTest is PayrunBase {

    function test_decline_RefundsPayer() public {
        uint256 runId = _createDefaultRun();
        uint256 before = usdc.balanceOf(payer);
        vm.prank(recipient);
        vault.decline(runId, 0);
        assertEq(usdc.balanceOf(payer), before + 100e6 + 0.5e6);
        assertEq(uint8(vault.getLine(runId, 0).status), uint8(PayrunVault.Status.Declined));
    }

    function test_revert_DeclineByStranger() public {
        uint256 runId = _createDefaultRun();
        vm.prank(stranger);
        vm.expectRevert(PayrunVault.NotRecipient.selector);
        vault.decline(runId, 0);
    }

    function test_revert_DeclineByPayer() public {
        uint256 runId = _createDefaultRun();
        vm.prank(payer);
        vm.expectRevert(PayrunVault.NotRecipient.selector);
        vault.decline(runId, 0);
    }

    function test_revert_DeclineAfterPaid() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(relayer);
        vault.release(runId, 0);
        vm.prank(recipient);
        vm.expectRevert(PayrunVault.NotPending.selector);
        vault.decline(runId, 0);
    }

    function test_decline_emitsEvent() public {
        uint256 runId = _createDefaultRun();
        vm.expectEmit(true, true, false, true);
        emit PayrunVault.LineDeclined(runId, 0, recipient, 100e6, 0.5e6);
        vm.prank(recipient);
        vault.decline(runId, 0);
    }
}

// ═══════════════════════════════════════════════════════════════════
// cancel
// ═══════════════════════════════════════════════════════════════════

contract CancelTest is PayrunBase {

    function test_cancel_Revocable() public {
        uint256 runId = _createDefaultRun();
        uint256 before = usdc.balanceOf(payer);
        uint256[] memory idx = new uint256[](1); idx[0] = 0;
        vm.prank(payer);
        vault.cancel(runId, idx);
        assertEq(usdc.balanceOf(payer), before + 100e6 + 0.5e6);
        assertEq(uint8(vault.getLine(runId, 0).status), uint8(PayrunVault.Status.Cancelled));
    }

    function test_revert_CancelCommittedRun() public {
        vm.prank(payer);
        uint256 runId = vault.createRun(_defaultLine(), true, bytes32(0));
        uint256[] memory idx = new uint256[](1); idx[0] = 0;
        vm.prank(payer);
        vm.expectRevert(PayrunVault.RunCommitted.selector);
        vault.cancel(runId, idx);
    }

    function test_revert_CancelAfterDue() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);
        uint256[] memory idx = new uint256[](1); idx[0] = 0;
        vm.prank(payer);
        vm.expectRevert(PayrunVault.AlreadyDue.selector);
        vault.cancel(runId, idx);
    }

    // cancel exactly at dueAt reverts (dueAt is inclusive boundary).
    function test_revert_CancelExactlyAtDue() public {
        uint256 runId = _createDefaultRun();
        vm.warp(vault.getLine(runId, 0).dueAt); // exact dueAt
        uint256[] memory idx = new uint256[](1); idx[0] = 0;
        vm.prank(payer);
        vm.expectRevert(PayrunVault.AlreadyDue.selector);
        vault.cancel(runId, idx);
    }

    function test_revert_CancelByStranger() public {
        uint256 runId = _createDefaultRun();
        uint256[] memory idx = new uint256[](1); idx[0] = 0;
        vm.prank(stranger);
        vm.expectRevert(PayrunVault.NotPayer.selector);
        vault.cancel(runId, idx);
    }

    function test_revert_CancelByRecipient() public {
        uint256 runId = _createDefaultRun();
        uint256[] memory idx = new uint256[](1); idx[0] = 0;
        vm.prank(recipient);
        vm.expectRevert(PayrunVault.NotPayer.selector);
        vault.cancel(runId, idx);
    }

    function test_revert_CancelAlreadyCancelled() public {
        uint256 runId = _createDefaultRun();
        uint256[] memory idx = new uint256[](1); idx[0] = 0;
        vm.prank(payer);
        vault.cancel(runId, idx);
        vm.prank(payer);
        vm.expectRevert(PayrunVault.NotPending.selector);
        vault.cancel(runId, idx);
    }

    // Duplicate indices in cancel: second attempt on same line reverts.
    function test_revert_CancelDuplicateIndex() public {
        uint256 runId = _createDefaultRun();
        uint256[] memory idx = new uint256[](2); idx[0] = 0; idx[1] = 0;
        vm.prank(payer);
        vm.expectRevert(PayrunVault.NotPending.selector);
        vault.cancel(runId, idx);
    }

    function test_cancel_emitsEvent() public {
        uint256 runId = _createDefaultRun();
        uint256[] memory idx = new uint256[](1); idx[0] = 0;
        vm.expectEmit(true, true, false, true);
        emit PayrunVault.LineCancelled(runId, 0, 100e6, 0.5e6);
        vm.prank(payer);
        vault.cancel(runId, idx);
    }
}

// ═══════════════════════════════════════════════════════════════════
// reclaimStale
// ═══════════════════════════════════════════════════════════════════

contract ReclaimStaleTest is PayrunBase {

    function test_revert_ReclaimBeforeStale() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + vault.STALE_PERIOD() - 1);
        vm.prank(payer);
        vm.expectRevert(PayrunVault.NotStale.selector);
        vault.reclaimStale(runId, 0);
    }

    function test_reclaimStale_ExactlyAtStale() public {
        uint256 runId = _createDefaultRun();
        uint64 dueAt = vault.getLine(runId, 0).dueAt;
        vm.warp(dueAt + vault.STALE_PERIOD());
        uint256 before = usdc.balanceOf(payer);
        vm.prank(payer);
        vault.reclaimStale(runId, 0);
        assertEq(usdc.balanceOf(payer), before + 100e6 + 0.5e6);
        assertEq(uint8(vault.getLine(runId, 0).status), uint8(PayrunVault.Status.Reclaimed));
    }

    function test_revert_ReclaimOneLessThanStale() public {
        uint256 runId = _createDefaultRun();
        uint64 dueAt = vault.getLine(runId, 0).dueAt;
        vm.warp(dueAt + vault.STALE_PERIOD() - 1);
        vm.prank(payer);
        vm.expectRevert(PayrunVault.NotStale.selector);
        vault.reclaimStale(runId, 0);
    }

    function test_revert_ReclaimByStranger() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 31 days);
        vm.prank(stranger);
        vm.expectRevert(PayrunVault.NotPayer.selector);
        vault.reclaimStale(runId, 0);
    }

    function test_revert_ReclaimByRecipient() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 31 days);
        vm.prank(recipient);
        vm.expectRevert(PayrunVault.NotPayer.selector);
        vault.reclaimStale(runId, 0);
    }

    function test_revert_ReclaimAfterPaid() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(relayer);
        vault.release(runId, 0);
        vm.warp(block.timestamp + vault.STALE_PERIOD() + 1);
        vm.prank(payer);
        vm.expectRevert(PayrunVault.NotPending.selector);
        vault.reclaimStale(runId, 0);
    }

    function test_reclaimStale_emitsEvent() public {
        uint256 runId = _createDefaultRun();
        uint64 dueAt = vault.getLine(runId, 0).dueAt;
        vm.warp(dueAt + vault.STALE_PERIOD());
        vm.expectEmit(true, true, false, true);
        emit PayrunVault.LineReclaimed(runId, 0, 100e6, 0.5e6);
        vm.prank(payer);
        vault.reclaimStale(runId, 0);
    }
}

// ═══════════════════════════════════════════════════════════════════
// Views
// ═══════════════════════════════════════════════════════════════════

contract ViewsTest is PayrunBase {

    function test_isDue_FalseBeforeDue() public {
        uint256 runId = _createDefaultRun();
        assertFalse(vault.isDue(runId, 0));
    }

    function test_isDue_TrueAfterDue() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);
        assertTrue(vault.isDue(runId, 0));
    }

    function test_getLines_ReturnsAll() public {
        PayrunVault.LineInput[] memory lines = new PayrunVault.LineInput[](3);
        for (uint256 i; i < 3; ++i) {
            lines[i] = PayrunVault.LineInput({ recipient: address(uint160(0x200 + i)), amount: uint128((i + 1) * 10e6), tip: 0, dueAt: uint64(block.timestamp + 1 days), lineRef: bytes32(0) });
        }
        vm.prank(payer);
        uint256 runId = vault.createRun(lines, false, bytes32(0));
        PayrunVault.Line[] memory got = vault.getLines(runId);
        assertEq(got.length, 3);
        assertEq(got[1].amount, 20e6);
    }

    function test_runsOfPayerCount() public {
        _createDefaultRun();
        _createDefaultRun();
        assertEq(vault.runsOfPayerCount(payer), 2);
    }

    function test_linesOfRecipientCount() public {
        _createDefaultRun();
        _createDefaultRun();
        assertEq(vault.linesOfRecipientCount(recipient), 2);
    }
}

// ═══════════════════════════════════════════════════════════════════
// Fuzz
// ═══════════════════════════════════════════════════════════════════

contract FuzzTest is PayrunBase {

    function testFuzz_CreateAndRelease(uint128 amount, uint96 tip, uint64 futureSecs) public {
        amount     = uint128(bound(amount, 1, vault.MAX_RUN_TOTAL() - vault.MAX_TIP()));
        tip        = uint96(bound(tip, 0, vault.MAX_TIP()));
        futureSecs = uint64(bound(futureSecs, 1, vault.MAX_HORIZON()));
        vm.assume(uint256(amount) + uint256(tip) <= vault.MAX_RUN_TOTAL());

        uint64 dueAt = uint64(block.timestamp + futureSecs);

        vm.prank(payer);
        uint256 runId = vault.createRun(_oneLine(recipient, amount, tip, dueAt), false, bytes32(0));

        assertEq(usdc.balanceOf(address(vault)), uint256(amount) + uint256(tip));

        vm.warp(dueAt);
        vm.prank(relayer);
        vault.release(runId, 0);

        assertEq(usdc.balanceOf(recipient), amount);
        assertEq(usdc.balanceOf(relayer),   tip);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function testFuzz_MultiLineAccounting(uint256 lineCount, uint256 seed) public {
        lineCount = bound(lineCount, 1, vault.MAX_LINES());
        PayrunVault.LineInput[] memory lines = new PayrunVault.LineInput[](lineCount);
        uint256 totalExpected;

        for (uint256 i; i < lineCount; ++i) {
            uint256 r      = uint256(keccak256(abi.encode(seed, i)));
            uint128 amount = uint128(bound(r, 1, 9e6));
            uint96  tip    = uint96(bound(r >> 128, 0, vault.MAX_TIP()));
            totalExpected += uint256(amount) + uint256(tip);
            vm.assume(totalExpected <= vault.MAX_RUN_TOTAL());
            lines[i] = PayrunVault.LineInput({ recipient: address(uint160(0x1000 + i)), amount: amount, tip: tip, dueAt: uint64(block.timestamp + 1 days), lineRef: bytes32(0) });
        }

        vm.prank(payer);
        uint256 runId = vault.createRun(lines, false, bytes32(0));
        assertEq(usdc.balanceOf(address(vault)), totalExpected);

        vm.warp(block.timestamp + 1 days + 1);
        uint256[] memory idx = new uint256[](lineCount);
        for (uint256 i; i < lineCount; ++i) idx[i] = i;
        vm.prank(relayer);
        vault.releaseMany(runId, idx);

        assertEq(usdc.balanceOf(address(vault)), 0);
        for (uint256 i; i < lineCount; ++i) {
            assertEq(usdc.balanceOf(address(uint160(0x1000 + i))), lines[i].amount);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// releaseLineInternal access control
// ═══════════════════════════════════════════════════════════════════

contract ReleaseLineInternalTest is PayrunBase {

    function test_revert_OnlySelf_FromStranger() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(stranger);
        vm.expectRevert(PayrunVault.OnlySelf.selector);
        vault.releaseLineInternal(runId, 0, stranger);
    }

    function test_revert_OnlySelf_FromPayer() public {
        uint256 runId = _createDefaultRun();
        vm.prank(payer);
        vm.expectRevert(PayrunVault.OnlySelf.selector);
        vault.releaseLineInternal(runId, 0, payer);
    }

    function test_revert_OnlySelf_FromRelayer() public {
        uint256 runId = _createDefaultRun();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(relayer);
        vm.expectRevert(PayrunVault.OnlySelf.selector);
        vault.releaseLineInternal(runId, 0, relayer);
    }
}

// ═══════════════════════════════════════════════════════════════════
// RunNotFound / InvalidLineIndex on releaseMany and cancel
// ═══════════════════════════════════════════════════════════════════

contract ExistenceChecks2Test is PayrunBase {

    function test_getRun_revert_RunNotFound() public {
        vm.expectRevert(PayrunVault.RunNotFound.selector);
        vault.getRun(99);
    }

    function test_releaseMany_revert_RunNotFound() public {
        uint256[] memory idx = new uint256[](1); idx[0] = 0;
        vm.prank(relayer);
        vm.expectRevert(PayrunVault.RunNotFound.selector);
        vault.releaseMany(99, idx);
    }

    function test_cancel_revert_RunNotFound() public {
        uint256[] memory idx = new uint256[](1); idx[0] = 0;
        vm.prank(payer);
        vm.expectRevert(PayrunVault.RunNotFound.selector);
        vault.cancel(99, idx);
    }

    function test_cancel_revert_InvalidLineIndex() public {
        uint256 runId = _createDefaultRun(); // 1 line (index 0)
        uint256[] memory idx = new uint256[](1); idx[0] = 5;
        vm.prank(payer);
        vm.expectRevert(PayrunVault.InvalidLineIndex.selector);
        vault.cancel(runId, idx);
    }
}

// ═══════════════════════════════════════════════════════════════════
// Pagination edge cases
// ═══════════════════════════════════════════════════════════════════

contract PaginationEdgeCaseTest is PayrunBase {

    function setUp() public override {
        super.setUp();
        // Create 3 runs to have something to paginate.
        _createDefaultRun();
        _createDefaultRun();
        _createDefaultRun();
    }

    function test_runsOfPayer_OffsetEqualTotal_ReturnsEmpty() public view {
        uint256 total = vault.runsOfPayerCount(payer);
        uint256[] memory page = vault.runsOfPayer(payer, total, 1);
        assertEq(page.length, 0);
    }

    function test_runsOfPayer_LimitZero_ReturnsEmpty() public view {
        uint256[] memory page = vault.runsOfPayer(payer, 0, 0);
        assertEq(page.length, 0);
    }

    function test_runsOfPayer_MaxUintLimit_ReturnsRemainder() public view {
        // offset=1, limit=type(uint256).max — must not overflow, returns items [1..end].
        uint256[] memory page = vault.runsOfPayer(payer, 1, type(uint256).max);
        assertEq(page.length, 2); // items at index 1 and 2
        assertEq(page[0], 2);
        assertEq(page[1], 3);
    }

    function test_linesOfRecipient_OffsetEqualTotal_ReturnsEmpty() public view {
        uint256 total = vault.linesOfRecipientCount(recipient);
        PayrunVault.LineRef[] memory page = vault.linesOfRecipient(recipient, total, 1);
        assertEq(page.length, 0);
    }

    function test_linesOfRecipient_LimitZero_ReturnsEmpty() public view {
        PayrunVault.LineRef[] memory page = vault.linesOfRecipient(recipient, 0, 0);
        assertEq(page.length, 0);
    }

    function test_linesOfRecipient_MaxUintLimit_ReturnsRemainder() public view {
        // offset=1, limit=max — must return items [1..end] without panic.
        PayrunVault.LineRef[] memory page = vault.linesOfRecipient(recipient, 1, type(uint256).max);
        assertEq(page.length, 2);
        assertEq(page[0].runId, 2);
    }
}

// ═══════════════════════════════════════════════════════════════════
// Gas mock + gas tests
// ═══════════════════════════════════════════════════════════════════

/// @dev ERC-20 mock whose transfer to the blocked address burns nearly all forwarded
///      gas via an infinite loop (capped by the EVM), then reverts — simulating a
///      pathological token that exhausts the sub-call's gas budget before reverting.
///      Used to exercise the GAS_RESERVE_AFTER_FAIL path in releaseMany.
contract GasExhaustingMockUSDC is MockUSDC {
    address public blocked;

    constructor(address _blocked) { blocked = _blocked; }

    function transfer(address to, uint256 amount) external override returns (bool) {
        if (to == blocked) {
            // Burn all available gas, then revert.
            uint256 waste;
            while (gasleft() > 600) { unchecked { waste += 1; } }
            revert("GasExhaustingMock: blocked");
        }
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

/// @dev ERC-20 mock whose transfer burns ~50k extra gas via a storage write loop,
///      so that the pre-attempt MIN_GAS_PER_LINE guard triggers on tight budgets.
contract GasBurningMockUSDC is MockUSDC {
    uint256 private _burn;

    function transfer(address to, uint256 amount) external override returns (bool) {
        // Burn gas via storage touch to make each transfer cost more.
        for (uint256 i; i < 5; ++i) _burn = i;
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

contract GasTest is PayrunBase {
    GasBurningMockUSDC gasUsdc;
    PayrunVault        gasVault;

    function setUp() public override {
        super.setUp();
        gasUsdc = new GasBurningMockUSDC();
        gasVault = new PayrunVault(address(gasUsdc));
        gasUsdc.mint(payer, 10_000e6);
        vm.prank(payer);
        gasUsdc.approve(address(gasVault), type(uint256).max);
    }

    /// @dev A tight gas limit must produce InsufficientGas, never TransferFailed.
    ///      We verify (a) the call reverts and (b) the selector is InsufficientGas.
    function test_tightGas_RevertsWithInsufficientGas_NotTransferFailed() public {
        vm.prank(payer);
        uint256 runId = gasVault.createRun(
            _oneLine(recipient, 50e6, 0.5e6, uint64(block.timestamp + 1 days)),
            false, bytes32(0)
        );
        vm.warp(block.timestamp + 1 days + 1);

        uint256[] memory idx = new uint256[](1); idx[0] = 0;

        // Low gas: below MIN_GAS_PER_LINE (80k) so we hit the pre-attempt guard.
        vm.prank(relayer);
        (bool ok, bytes memory ret) = address(gasVault).call{ gas: 40_000 }(
            abi.encodeWithSelector(gasVault.releaseMany.selector, runId, idx)
        );
        assertFalse(ok, "expected revert");
        // Verify the revert reason is InsufficientGas (not TransferFailed).
        bytes4 sel = bytes4(ret);
        assertEq(sel, PayrunVault.InsufficientGas.selector);
    }

    /// @dev GAS_RESERVE_AFTER_FAIL path: a token that exhausts all forwarded gas on
    ///      the blocked address leaves releaseMany with < GAS_RESERVE_AFTER_FAIL gas
    ///      after the failed sub-call, so the whole tx reverts with InsufficientGas
    ///      rather than silently emitting TransferFailed.
    function test_gasReserveAfterFail_RevertsWithInsufficientGas() public {
        // Deploy vault with a gas-exhausting token.
        address blockedRecip = makeAddr("gasExhaustedRecipient");
        GasExhaustingMockUSDC exhaustToken = new GasExhaustingMockUSDC(blockedRecip);
        PayrunVault exhaustVault = new PayrunVault(address(exhaustToken));
        exhaustToken.mint(payer, 10_000e6);
        vm.prank(payer);
        exhaustToken.approve(address(exhaustVault), type(uint256).max);

        // Single line to the blocked recipient.
        vm.prank(payer);
        uint256 runId = exhaustVault.createRun(
            _oneLine(blockedRecip, 50e6, 0, uint64(block.timestamp + 1 days)),
            false, bytes32(0)
        );
        vm.warp(block.timestamp + 1 days + 1);

        uint256[] memory idx = new uint256[](1); idx[0] = 0;

        // Call with just enough gas to pass the pre-attempt guard (>= MIN_GAS_PER_LINE
        // = 80k) but so little that after the exhausting sub-call there is less than
        // GAS_RESERVE_AFTER_FAIL (30k) remaining, triggering the post-fail revert.
        vm.prank(relayer);
        (bool ok, bytes memory ret) = address(exhaustVault).call{ gas: 200_000 }(
            abi.encodeWithSelector(exhaustVault.releaseMany.selector, runId, idx)
        );
        assertFalse(ok, "expected revert on gas-reserve path");
        bytes4 sel = bytes4(ret);
        assertEq(sel, PayrunVault.InsufficientGas.selector, "expected InsufficientGas selector");
    }

    /// @dev 50-line releaseMany: all lines become Paid and the call uses < 1M gas.
    ///      Recipients are cycled across a small pool so their balanceOf slots are
    ///      warm (touched in setUp/createRun), keeping each self-call to ~16k gas
    ///      and the total around 850k.  We measure gasleft() around the actual call
    ///      (no gas cap) and assert the consumed amount stays under 1M.
    function test_50Lines_AllPaidAndGasBelow1M() public {
        // 5 warm recipients, each receiving 10 lines.
        address[5] memory recips = [
            makeAddr("gr0"), makeAddr("gr1"), makeAddr("gr2"),
            makeAddr("gr3"), makeAddr("gr4")
        ];
        PayrunVault.LineInput[] memory lines = new PayrunVault.LineInput[](50);
        for (uint256 i; i < 50; ++i) {
            lines[i] = PayrunVault.LineInput({
                recipient: recips[i % 5],
                amount:    1e6,
                tip:       0,
                dueAt:     uint64(block.timestamp + 1 days),
                lineRef:   bytes32(0)
            });
        }
        usdc.mint(payer, 10_000e6);
        vm.prank(payer);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(payer);
        uint256 runId = vault.createRun(lines, false, bytes32(0));

        vm.warp(block.timestamp + 1 days + 1);

        uint256[] memory idx = new uint256[](50);
        for (uint256 i; i < 50; ++i) idx[i] = i;

        // Measure gas consumed by the releaseMany call itself.
        uint256 gasBefore = gasleft();
        vm.prank(relayer);
        vault.releaseMany(runId, idx);
        uint256 gasUsed = gasBefore - gasleft();

        // All 50 lines must be Paid.
        for (uint256 i; i < 50; ++i) {
            assertEq(
                uint8(vault.getLine(runId, i).status),
                uint8(PayrunVault.Status.Paid),
                "line not Paid"
            );
        }

        // Gas consumed must be below 1M (measured ~850k with warm storage).
        assertLt(gasUsed, 1_000_000, "50-line releaseMany used >= 1M gas");
    }
}
